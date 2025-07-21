import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { VerifiedPermissionsClient, IsAuthorizedCommand } from '@aws-sdk/client-verifiedpermissions';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

const ddbClient = captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = captureAWSv3Client(new S3Client({}));
const secretsClient = captureAWSv3Client(new SecretsManagerClient({}));
const vpClient = captureAWSv3Client(new VerifiedPermissionsClient({}));
const kinesisClient = captureAWSv3Client(new KinesisClient({}));
const cwClient = captureAWSv3Client(new CloudWatchClient({}));

const POLICY_STORE_ID = process.env.POLICY_STORE_ID!;
const BUCKET_NAME = process.env.STORAGE_BUCKET_NAME!;
const ANALYTICS_STREAM = process.env.ANALYTICS_STREAM!;

export const handler = async (event: any) => {
  const { fieldName, arguments: args, identity } = event;
  const userId = identity.sub;
  const tenantId = identity['custom:tenantId'];

  // Fetch secrets
  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: 'resumeConfig' }));
  const config = JSON.parse(secret.SecretString || '{}');

  switch (fieldName) {
    case 'listTemplates':
      // Verified Permissions
      const vpResponse = await vpClient.send(new IsAuthorizedCommand({
        policyStoreId: POLICY_STORE_ID,
        principal: { entityType: 'User', entityId: userId },
        resource: { entityType: 'Template', entityId: '*' },
        action: { actionType: 'Action', actionId: 'listTemplates' }
      }));
      if (vpResponse.decision !== 'ALLOW') throw new Error('Access Denied');

      // Scan DynamoDB for templates (filter by tenantId)
      const templates = await docClient.send(new ScanCommand({
        TableName: 'Template',
        FilterExpression: 'tenantId = :tenantId',
        ExpressionAttributeValues: { ':tenantId': tenantId }
      }));

      // Fetch S3 files
      const fullTemplates = await Promise.all(templates.Items?.map(async (item) => {
        const s3Data = await s3Client.send(new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: item.s3Path
        }));
        const body = await s3Data.Body?.transformToString();
        return { ...item, file: body } as { templateId: string; isPremium: boolean; file: string | undefined; s3Path: string; tenantId: string };
      }) || []);

      // Query purchases for premium
      const purchases = await docClient.send(new QueryCommand({
        TableName: 'Purchase',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId }
      }));
      const purchasedIds = purchases.Items?.map(p => p.templateId) || [];

      // Filter to include free + purchased
      const accessible = fullTemplates.filter(t => !t.isPremium || purchasedIds.includes(t.templateId));

      // Log metric to CloudWatch
      await cwClient.send(new PutMetricDataCommand({
        MetricData: [{ MetricName: 'TemplateAccess', Value: 1 }],
        Namespace: 'ResumeBuilder'
      }));

      // Log to Kinesis
      await kinesisClient.send(new PutRecordCommand({
        StreamName: ANALYTICS_STREAM,
        Data: Buffer.from(JSON.stringify({ event: 'templateView', userId })),
        PartitionKey: userId
      }));

      return accessible;

    default:
      throw new Error('Unknown field');
  }
};