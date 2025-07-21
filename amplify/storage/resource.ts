import { defineStorage } from '@aws-amplify/backend';

export const storage = defineStorage({
  name: 'resumeBuilderStorage',
  access: (allow) => ({
    'resumes/{entityId}/*': [
      allow.entity('identity').to(['read', 'write', 'delete'])
    ],
    'pdfs/{entityId}/*': [
      allow.entity('identity').to(['read', 'write', 'delete'])
    ],
    'templates/*': [
      allow.authenticated.to(['read']),
      allow.entity('identity').to(['write'])
    ],
    'affiliates/{entityId}/*': [
      allow.entity('identity').to(['read', 'write'])
    ]
  })
});