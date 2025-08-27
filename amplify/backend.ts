import * as amplify from '@aws-amplify/backend';
import * as auth from 'aws-cdk-lib/aws-cognito';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

const backend = new amplify.Backend(this, 'Backend', {
  auth: new auth.UserPool(this, 'UserPool', {
    selfSignUpEnabled: true,
    autoVerify: { email: true },
  }),
  api: new appsync.GraphqlApi(this, 'Api', {
    name: 'resumeBuilderApi',
    schema: appsync.Schema.fromAsset('amplify/data/schema.graphql'),
  }),
  function: new lambda.Function(this, 'ResumeFunction', {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: lambda.Code.fromAsset('amplify/functions/resume-service'),
    role: new iam.Role(this, 'LambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    }),
    loggingFormat: lambda.LoggingFormat.TEXT,
  }),
});