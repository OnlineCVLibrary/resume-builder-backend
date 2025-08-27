import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';
import { storage } from './storage/resource';
import { defineFunction } from '@aws-amplify/backend-function';
import * as cdk from 'aws-cdk-lib';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as verifiedpermissions from 'aws-cdk-lib/aws-verifiedpermissions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Function } from 'aws-cdk-lib/aws-lambda';

const backend = defineBackend({
  auth,
  data,
  storage,
  resumeService: defineFunction({
    entry: './function/resumeService/src/index.ts'
  }),
  templateService: defineFunction({
    entry: './function/templateService/src/index.ts'
  }),
  jobService: defineFunction({
    entry: './function/jobService/src/index.ts'
  }),
  pdfTrigger: defineFunction({
    entry: './function/pdfTrigger/src/index.ts'
  })
});

// Set environments
backend.resumeService.addEnvironment('STORAGE_BUCKET_NAME', backend.storage.resources.bucket?.bucketName || '');
backend.templateService.addEnvironment('STORAGE_BUCKET_NAME', backend.storage.resources.bucket?.bucketName || '');
backend.jobService.addEnvironment('STORAGE_BUCKET_NAME', backend.storage.resources.bucket?.bucketName || '');
backend.pdfTrigger.addEnvironment('STORAGE_BUCKET_NAME', backend.storage.resources.bucket?.bucketName || '');

// Attach resolvers to AppSync
const resumeDS = backend.data.addLambdaDataSource('resumeDS', backend.resumeService);
backend.data.resources.graphqlApi.addResolver({ typeName: 'Mutation', fieldName: 'createResume', dataSource: resumeDS });
backend.data.resources.graphqlApi.addResolver({ typeName: 'Query', fieldName: 'getResumes', dataSource: resumeDS });
backend.data.resources.graphqlApi.addResolver({ typeName: 'Mutation', fieldName: 'purchaseTemplate', dataSource: resumeDS });
backend.data.resources.graphqlApi.addResolver({ typeName: 'Mutation', fieldName: 'trackAffiliate', dataSource: resumeDS });

const templateDS = backend.data.addLambdaDataSource('templateDS', backend.templateService);
backend.data.resources.graphqlApi.addResolver({ typeName: 'Query', fieldName: 'listTemplates', dataSource: templateDS });

const jobDS = backend.data.addLambdaDataSource('jobDS', backend.jobService);
backend.data.resources.graphqlApi.addResolver({ typeName: 'Query', fieldName: 'getJobMatches', dataSource: jobDS });
backend.data.resources.graphqlApi.addResolver({ typeName: 'Mutation', fieldName: 'applyJob', dataSource: jobDS });

const pdfDS = backend.data.addLambdaDataSource('pdfDS', backend.pdfTrigger);
backend.data.resources.graphqlApi.addResolver({ typeName: 'Mutation', fieldName: 'generatePDF', dataSource: pdfDS });

// CDK Custom Resources
const customStack = new cdk.Stack(backend.data.resources.cdkStack.scope, 'CustomResourcesStack');

// Add permissions to Amplify role
const amplifyRole = backend.data.resources.cdkStack.node.tryFindChild('AmplifyRole') as iam.Role;
amplifyRole.addToPolicy(new iam.PolicyStatement({
  actions: [
    'elasticache:CreateCacheCluster',
    'elasticache:CreateSubnetGroup',
    'sqs:CreateQueue',
    'sfn:CreateStateMachine',
    'events:CreateEventBus',
    'sns:CreateTopic',
    'kinesis:CreateStream',
    'secretsmanager:CreateSecret',
    'ecs:RunTask',
    'ecs:DescribeTasks'
  ],
  resources: ['*']
}));

// Verified Permissions
const policyStore = new verifiedpermissions.CfnPolicyStore(customStack, 'ResumePolicyStore', {
  validationSettings: { mode: 'STRICT' }
});

// ElastiCache Redis
const vpc = ec2.Vpc.fromLookup(customStack, 'DefaultVpc', { isDefault: true });
const subnetGroup = new elasticache.CfnSubnetGroup(customStack, 'RedisSubnetGroup', {
  subnetIds: vpc.privateSubnets.map(s => s.subnetId),
  description: 'Subnet group for Redis'
});
const redisCluster = new elasticache.CfnCacheCluster(customStack, 'ResumeRedis', {
  engine: 'redis',
  cacheNodeType: 'cache.t3.micro',
  numCacheNodes: 1,
  cacheSubnetGroupName: subnetGroup.ref
});
redisCluster.addDependency(subnetGroup);

// SQS for PDF
const pdfQueue = new sqs.Queue(customStack, 'PdfQueue', {
  visibilityTimeout: cdk.Duration.minutes(5)
});

// Step Functions
const pdfGenLambda = new Function(customStack, 'PdfGenLambda', {
  runtime: cdk.aws_lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => { console.log("PDF Gen Placeholder"); return { status: "success" }; };')
});
const pdfTask = new tasks.LambdaInvoke(customStack, 'PdfGenTask', {
  lambdaFunction: pdfGenLambda
});
const pdfWorkflow = new sfn.StateMachine(customStack, 'PdfWorkflow', {
  definitionBody: sfn.DefinitionBody.fromChainable(pdfTask)
});

// SNS
const notificationTopic = new sns.Topic(customStack, 'ResumeNotifications');

// EventBridge
const eventBus = new events.EventBus(customStack, 'ResumeEventBus');
const pdfCompletionRule = new events.Rule(customStack, 'PdfCompletionRule', {
  eventBus,
  eventPattern: { detailType: ['PDFCompleted'] }
});
pdfCompletionRule.addTarget(new targets.SnsTopic(notificationTopic));

// Kinesis
const analyticsStream = new kinesis.Stream(customStack, 'ResumeAnalytics', { shardCount: 1 });

// Secrets Manager
new secretsmanager.Secret(customStack, 'ResumeSecrets', {
  generateSecretString: { secretStringTemplate: JSON.stringify({ s3Bucket: backend.storage.resources.bucket?.bucketName || '' }) }
});

// ECS Fargate
const cluster = new ecs.Cluster(customStack, 'PdfCluster', { vpc });
const pdfTaskDefinition = new ecs.FargateTaskDefinition(customStack, 'PdfTask', {
  memoryLimitMiB: 512,
  cpu: 256
});
pdfTaskDefinition.addContainer('PdfContainer', {
  image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'), // Replace with your ECR URI
  logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'pdf' }),
  environment: { BUCKET_NAME: backend.storage.resources.bucket?.bucketName || '' }
});
const queueProcessingService = new ecs_patterns.QueueProcessingFargateService(customStack, 'PdfQueueService', {
  cluster,
  taskDefinition: pdfTaskDefinition,
  queue: pdfQueue,
  minScalingCapacity: 0,
  maxScalingCapacity: 5,
  scalingSteps: [{ upper: 0, change: 0 }, { lower: 1, change: +1 }]
});

// Outputs
backend.addOutput({
  custom: {
    policyStoreId: policyStore.ref,
    redisEndpoint: redisCluster.attrRedisEndpointAddress,
    pdfQueueUrl: pdfQueue.queueUrl,
    pdfWorkflowArn: pdfWorkflow.stateMachineArn,
    eventBusName: eventBus.eventBusName,
    notificationTopic: notificationTopic.topicArn,
    analyticsStream: analyticsStream.streamName
  }
});

// Set env vars
backend.resumeService.addEnvironment('POLICY_STORE_ID', policyStore.ref);
backend.resumeService.addEnvironment('REDIS_ENDPOINT', redisCluster.attrRedisEndpointAddress);
backend.resumeService.addEnvironment('PDF_WORKFLOW_ARN', pdfWorkflow.stateMachineArn);
backend.resumeService.addEnvironment('ANALYTICS_STREAM', analyticsStream.streamName);

backend.templateService.addEnvironment('POLICY_STORE_ID', policyStore.ref);
backend.templateService.addEnvironment('ANALYTICS_STREAM', analyticsStream.streamName);

backend.jobService.addEnvironment('POLICY_STORE_ID', policyStore.ref);
backend.jobService.addEnvironment('NOTIFICATION_TOPIC', notificationTopic.topicArn);
backend.jobService.addEnvironment('ANALYTICS_STREAM', analyticsStream.streamName);

backend.pdfTrigger.addEnvironment('POLICY_STORE_ID', policyStore.ref);
backend.pdfTrigger.addEnvironment('PDF_QUEUE_URL', pdfQueue.queueUrl);
backend.pdfTrigger.addEnvironment('EVENT_BUS_NAME', eventBus.eventBusName);
backend.pdfTrigger.addEnvironment('NOTIFICATION_TOPIC', notificationTopic.topicArn);
backend.pdfTrigger.addEnvironment('ANALYTICS_STREAM', analyticsStream.streamName);