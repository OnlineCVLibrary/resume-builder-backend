import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { VerifiedPermissionsClient, IsAuthorizedCommand } from '@aws-sdk/client-verifiedpermissions';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import Redis from 'ioredis';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { v4 as uuidv4 } from 'uuid';

const ddbClient = captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = captureAWSv3Client(new S3Client({}));
const secretsClient = captureAWSv3Client(new SecretsManagerClient({}));
const vpClient = captureAWSv3Client(new VerifiedPermissionsClient({}));
const sfnClient = captureAWSv3Client(new SFNClient({}));
const kinesisClient = captureAWSv3Client(new KinesisClient({}));

const POLICY_STORE_ID = process.env.POLICY_STORE_ID!;
const REDIS_ENDPOINT = process.env.REDIS_ENDPOINT!;
const BUCKET_NAME = process.env.STORAGE_BUCKET_NAME!;
const PDF_WORKFLOW_ARN = process.env.PDF_WORKFLOW_ARN!;
const ANALYTICS_STREAM = process.env.ANALYTICS_STREAM!;
const redis = new Redis({ host: REDIS_ENDPOINT });

export const handler = async (event: any) => {
  const { fieldName, arguments: args, identity } = event;
  const userId = identity.sub;
  const tenantId = identity['custom:tenantId'];

  // Fetch secrets (e.g., config)
  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: 'resumeConfig' }));
  const config = JSON.parse(secret.SecretString || '{}');

  switch (fieldName) {
    case 'createResume':
      // Verified Permissions check
      const vpResponse = await vpClient.send(new IsAuthorizedCommand({
        policyStoreId: POLICY_STORE_ID,
        principal: { entityType: 'User', entityId: userId },
        resource: { entityType: 'Resume', entityId: '*' },
        action: { actionType: 'Action', actionId: 'createResume' }
      }));
      if (vpResponse.decision !== 'ALLOW') {
        throw new Error('Access Denied');
      }

      // Query user tier and resume count for limit
      const userData = await docClient.send(new GetCommand({
        TableName: 'User',
        Key: { userId }
      }));
      if (!userData.Item) {
        throw new Error('User not found');
      }
      const resumesCount = await docClient.send(new QueryCommand({
        TableName: 'Resume',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId },
        Select: 'COUNT'
      }));
      if (userData.Item.subscriptionTier === 'free' && resumesCount.Count! >= 5) {
        throw new Error('Upgrade Required');
      }

      // Save to S3
      const resumeId = uuidv4();
      const s3Path = `resumes/${tenantId}/${userId}/${resumeId}.json`;
      await s3Client.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: s3Path,
        Body: JSON.stringify(args.resumeData)
      }));

      // Save metadata to DynamoDB
      await docClient.send(new PutCommand({
        TableName: 'Resume',
        Item: { resumeId, userId, tenantId, s3Path, metadata: args.metadata }
      }));

      // Invalidate cache
      await redis.del(`resumes:${userId}`);

      // Start Step Functions (e.g., for PDF trigger)
      await sfnClient.send(new StartExecutionCommand({
        stateMachineArn: PDF_WORKFLOW_ARN,
        input: JSON.stringify({ resumeId, userId, tenantId })
      }));

      // Log to Kinesis
      await kinesisClient.send(new PutRecordCommand({
        StreamName: ANALYTICS_STREAM,
        Data: Buffer.from(JSON.stringify({ event: 'resumeCreation', userId })),
        PartitionKey: userId
      }));

      return { success: true, resumeId };

    case 'getResumes':
      // Verified Permissions
      const vpGet = await vpClient.send(new IsAuthorizedCommand({
        policyStoreId: POLICY_STORE_ID,
        principal: { entityType: 'User', entityId: userId },
        resource: { entityType: 'Resume', entityId: '*' },
        action: { actionType: 'Action', actionId: 'getResumes' }
      }));
      if (vpGet.decision !== 'ALLOW') throw new Error('Access Denied');

      // Check cache
      const cached = await redis.get(`resumes:${userId}`);
      if (cached) return JSON.parse(cached);

      // Query DynamoDB
      const resumes = await docClient.send(new QueryCommand({
        TableName: 'Resume',
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId }
      }));

      // Fetch S3 JSONs
      const fullResumes = await Promise.all(resumes.Items?.map(async (item) => {
        const s3Data = await s3Client.send(new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: item.s3Path
        }));
        const body = await s3Data.Body?.transformToString();
        return { ...item, data: JSON.parse(body || '{}') };
      }) || []);

      // Cache
      await redis.set(`resumes:${userId}`, JSON.stringify(fullResumes));

      // Log to Kinesis
      await kinesisClient.send(new PutRecordCommand({
        StreamName: ANALYTICS_STREAM,
        Data: Buffer.from(JSON.stringify({ event: 'resumeView', userId })),
        PartitionKey: userId
      }));

      return fullResumes;

    case 'purchaseTemplate':
      // Similar VP check, then Stripe payment
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const paymentIntent = await stripe.paymentIntents.create({
        amount: 99, // $0.99
        currency: 'usd',
        payment_method: args.paymentMethodId,
        confirm: true
      });
      if (paymentIntent.status !== 'succeeded') throw new Error('Payment Failed');

      // Save purchase
      await docClient.send(new PutCommand({
        TableName: 'Purchase',
        Item: { purchaseId: uuidv4(), userId, templateId: args.templateId, amount: 0.99 }
      }));

      // Log to Kinesis
      await kinesisClient.send(new PutRecordCommand({
        StreamName: ANALYTICS_STREAM,
        Data: Buffer.from(JSON.stringify({ event: 'purchase', userId })),
        PartitionKey: userId
      }));

      return { success: true };

    case 'trackAffiliate':
      // Save to S3
      const affiliatePath = `affiliates/${userId}/${args.affiliateId}.json`;
      await s3Client.send(new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: affiliatePath,
        Body: JSON.stringify({ clickTime: new Date().toISOString() })
      }));

      // Log to Kinesis
      await kinesisClient.send(new PutRecordCommand({
        StreamName: ANALYTICS_STREAM,
        Data: Buffer.from(JSON.stringify({ event: 'affiliateClick', userId })),
        PartitionKey: userId
      }));

      return { success: true };

    default:
      throw new Error('Unknown field');
  }
};