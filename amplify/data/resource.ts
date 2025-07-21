import { a, defineData, type ClientSchema } from '@aws-amplify/backend';

export const schema = a.schema({
  User: a.model({
    userId: a.id().required(),
    email: a.string().required(),
    tenantId: a.string().required(),
    subscriptionTier: a.enum(['free', 'premium']),
    role: a.string()
  }).authorization(allow => [allow.owner()]),

  Resume: a.model({
    resumeId: a.id().required(),
    userId: a.id().required(),
    tenantId: a.string().required(),
    s3Path: a.string().required(),
    metadata: a.json()
  }).authorization(allow => [allow.ownerDefinedIn('userId')]),

  Template: a.model({
    templateId: a.id().required(),
    tenantId: a.string(),
    s3Path: a.string().required(),
    isPremium: a.boolean()
  }).authorization(allow => [allow.authenticated()]),

  Purchase: a.model({
    purchaseId: a.id().required(),
    userId: a.id().required(),
    templateId: a.id(),
    amount: a.float()
  }).authorization(allow => [allow.ownerDefinedIn('userId')]),

  Job: a.model({
    jobId: a.id().required(),
    skills: a.string().array(),
    description: a.string()
  }).authorization(allow => [allow.authenticated()])
});

export type Schema = ClientSchema<typeof schema>;

export const data = defineData({
  schema,
  authorizationModes: {
    defaultAuthorizationMode: 'userPool',
    userPoolConfig: {}
  }
});