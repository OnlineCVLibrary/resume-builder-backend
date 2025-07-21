import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { VerifiedPermissionsClient, IsAuthorizedCommand } from '@aws-sdk/client-verifiedpermissions';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { captureAWSv3Client } from 'aws-xray-sdk-core';

const ddbClient = captureAWSv3Client(new DynamoDBClient({}));
const docClient = DynamoDBDocumentClient.from(ddbClient);
const s3Client = captureAWSv3Client(new S3Client({}));
const secretsClient = captureAWSv3Client(new SecretsManagerClient({}));
const vpClient = captureAWSv3Client(new VerifiedPermissionsClient({}));
const bedrockClient = captureAWSv3Client(new BedrockRuntimeClient({ region: 'us-east-1' })); // Claude region
const snsClient = captureAWSv3Client(new SNSClient({}));
const kinesisClient = captureAWSv3Client(new KinesisClient({}));

const POLICY_STORE_ID = process.env.POLICY_STORE_ID!;
const BUCKET_NAME = process.env.STORAGE_BUCKET_NAME!;
const NOTIFICATION_TOPIC = process.env.NOTIFICATION_TOPIC!;
const ANALYTICS_STREAM = process.env.ANALYTICS_STREAM!;

export const handler = async (event: any) => {
  const { fieldName, arguments: args, identity } = event;
  const userId = identity.sub;
  const tenantId = identity['custom:tenantId'];

  // Fetch secrets
  const secret = await secretsClient.send(new GetSecretValueCommand({ SecretId: 'resumeConfig' }));
  const config = JSON.parse(secret.SecretString || '{}');

  switch (fieldName) {
    case 'getJobMatches':
      // Verified Permissions
      const vpResponse = await vpClient.send(new IsAuthorizedCommand({
        policyStoreId: POLICY_STORE_ID,
        principal: { entityType: 'User', entityId: userId },
        resource: { entityType: 'Job', entityId: '*' },
        action: { actionType: 'Action', actionId: 'getJobs' }
      }));
      if (vpResponse.decision !== 'ALLOW') throw new Error('Access Denied');

      // Query resume metadata
      const resume = await docClient.send(new GetCommand({
        TableName: 'Resume',
        Key: { resumeId: args.resumeId }
      }));
      if (!resume.Item) throw new Error('Resume not found');

      // Fetch resume JSON from S3
      const s3Data = await s3Client.send(new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: resume.Item.s3Path
      }));
      const resumeText = await s3Data.Body?.transformToString();

      // Analyze with Bedrock (Claude for skills extraction)
      const bedrockResponse = await bedrockClient.send(new InvokeModelCommand({
        modelId: 'anthropic.claude-v2',
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          prompt: `\n\nHuman: Extract skills from this resume: ${resumeText}\n\nAssistant:`,
          max_tokens_to_sample: 300,
          temperature: 0.5
        })
      }));
      const skills = JSON.parse(new TextDecoder().decode(bedrockResponse.body)).completion.match(/skills: (.*)/)?.[1].split(', ') || [];

      // Query jobs by skills (using GSI)
      const jobs = await docClient.send(new QueryCommand({
        TableName: 'Job',
        IndexName: 'skills-index', // Auto-generated name for secondary index
        KeyConditionExpression: 'skills = :skills',
        ExpressionAttributeValues: { ':skills': skills.join(',') }
      }));

      // Log to Kinesis
      await kinesisClient.send(new PutRecordCommand({
        StreamName: ANALYTICS_STREAM,
        Data: Buffer.from(JSON.stringify({ event: 'jobMatch', userId })),
        PartitionKey: userId
      }));

      return jobs.Items;

    case 'applyJob':
      // Stripe payment for premium
      const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
      const paymentIntent = await stripe.paymentIntents.create({
        amount: 100, // $1
        currency: 'usd',
        payment_method: args.paymentMethodId,
        confirm: true
      });
      if (paymentIntent.status !== 'succeeded') throw new Error('Payment Failed');

      // Notify employer via SNS
      await snsClient.send(new PublishCommand({
        TopicArn: NOTIFICATION_TOPIC,
        Message: `New application for job ${args.jobId} from user ${userId}`
      }));

      // Log to Kinesis
      await kinesisClient.send(new PutRecordCommand({
        StreamName: ANALYTICS_STREAM,
        Data: Buffer.from(JSON.stringify({ event: 'jobApplication', userId })),
        PartitionKey: userId
      }));

      return { success: true };

    default:
      throw new Error('Unknown field');
  }
};