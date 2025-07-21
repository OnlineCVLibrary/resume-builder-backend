import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { VerifiedPermissionsClient, IsAuthorizedCommand } from '@aws-sdk/client-verifiedpermissions';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

const ddbClient = captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = captureAWSv3Client(new S3Client({}));
const secretsClient = captureAWSv3Client(new SecretsManagerClient({}));
const vpClient = captureAWSv3Client(new VerifiedPermissionsClient({}));
const sqsClient = captureAWSv3Client(new SQSClient({}));
const eventBridgeClient = captureAWSv3Client(new EventBridgeClient({}));
const snsClient = captureAWSv3Client(new SNSClient({}));
const kinesisClient = captureAWSv3Client(new KinesisClient({}));

const POLICY_STORE_ID = process.env.POLICY_STORE_ID!;
const BUCKET_NAME = process.env.STORAGE_BUCKET_NAME!;
const PDF_QUEUE_URL = process.env.PDF_QUEUE_URL!;
const EVENT_BUS_NAME = process.env.EVENT_BUS_NAME!;
const NOTIFICATION_TOPIC = process.env.NOTIFICATION_TOPIC!;
const ANALYTICS_STREAM = process.env.ANALYTICS_STREAM!;

export const handler = async (event: any) => {
  const { fieldName, arguments: args, identity } = event;
  const userId = identity.sub;
  const tenantId = identity['custom:tenantId'];

  if (fieldName !== 'generatePDF') throw new Error('Unknown field');

  // Verified Permissions
  const vpResponse = await vpClient.send(new IsAuthorizedCommand({
    policyStoreId: POLICY_STORE_ID,
    principal: { entityType: 'User', entityId: userId },
    resource: { entityType: 'PDF', entityId: '*' },
    action: { actionType: 'Action', actionId: 'generatePDF' }
  }));
  if (vpResponse.decision !== 'ALLOW') throw new Error('Access Denied');

  // Fetch secrets
  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: 'resumeConfig' }));
  const config = JSON.parse(secret.SecretString || '{}');

  // Query user tier (PDF is premium feature)
  const userData = await docClient.send(new GetCommand({
    TableName: 'User',
    Key: { userId }
  }));
  const isPremium = userData.Item?.subscriptionTier === 'premium';
  if (!isPremium) throw new Error('Upgrade Required');

  // Fetch resume metadata and JSON
  const resume = await docClient.send(new GetCommand({
    TableName: 'Resume',
    Key: { resumeId: args.resumeId }
  }));
  const s3Data = await s3Client.send(new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: resume.Item?.s3Path
  }));
  const resumeJson = await s3Data.Body?.transformToString();

  // Queue task to SQS for Fargate
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: PDF_QUEUE_URL,
    MessageBody: JSON.stringify({ resumeId: args.resumeId, userId, tenantId, resumeJson, isPremium })
  }));

  // For completion (assuming Fargate triggers EventBridge on finish)
  // Here, just log queued
  await kinesisClient.send(new PutRecordCommand({
    StreamName: ANALYTICS_STREAM,
    Data: Buffer.from(JSON.stringify({ event: 'pdfGeneration', userId })),
    PartitionKey: userId
  }));

  // Example: Trigger EventBridge for immediate events
  await eventBridgeClient.send(new PutEventsCommand({
    Entries: [{
      Source: 'resume.builder',
      DetailType: 'PDFQueued',
      Detail: JSON.stringify({ resumeId: args.resumeId }),
      EventBusName: EVENT_BUS_NAME
    }]
  }));

  // SNS notification (e.g., email link after, but here placeholder)
  await snsClient.send(new PublishCommand({
    TopicArn: NOTIFICATION_TOPIC,
    Message: `PDF generation queued for resume ${args.resumeId}`
  }));

  return { success: true };
};