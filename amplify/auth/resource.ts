import { defineAuth } from '@aws-amplify/backend';

export const auth = defineAuth({
  loginWith: {
    email: {
      verificationEmailSubject: () => 'Verify your email for Resume Builder',
      verificationEmailBody: (createCode) => `Your verification code is ${createCode()}`
    },
    externalProviders: {
      google: {
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        scopes: ['email', 'profile'],
        attributeMapping: {
          email: 'email',
          custom: {
            tenantId: 'custom:tenantId'
          }
        }
      },
      logoutUrls: ['http://localhost:3000', 'https://main.d10uvoh7vwhrar.amplifyapp.com/'],
      callbackUrls: ['http://localhost:3000', 'https://main.d10uvoh7vwhrar.amplifyapp.com/']
    }
  },
  userAttributes: {
    custom: {
      tenantId: { mutable: true, required: true },
      role: { mutable: true },
      subscriptionTier: { mutable: true }
    }
  },
  multifactor: {
    mode: 'OPTIONAL',
    sms: true,
    totp: true
  }
});