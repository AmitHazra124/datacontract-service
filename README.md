# Datacontracts service

This CDK application exposes `POST /stacks` through API Gateway, starts a Step Functions execution, and provisions a CloudFormation stack from the submitted template.

## Request body

```json
{
  "stackName": "customer-contract",
  "templateBody": "AWSTemplateFormatVersion: '2010-09-09'\nResources: {}",
  "parameters": {
    "Environment": "dev"
  },
  "capabilities": ["CAPABILITY_IAM"]
}
```

## Deploy

The CDK app reads one target account and region from `manifest.yml`. The account is supplied through `AWS_ACCOUNT_ID`, allowing the same manifest to work with whichever CircleCI context is selected. The `aws-dev` context is used for the automatic `main` deployment.

The CircleCI workflow deploys `dev` automatically when a pull request is merged into `main`. It uses the `aws-dev` context, which should contain the dev account's AWS credentials and deployment parameters.

Export temporary AWS credentials in the terminal before running CDK. The AWS SDK/CDK default credential chain reads `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, and `AWS_REGION` directly from the process environment.

Then run:

```bash
yarn install
yarn cdk bootstrap
yarn cdk deploy
```

The deployment outputs the API Gateway HTTPS URL. A custom domain can be added later when a Route 53 hosted zone and ACM certificate are available.

## CircleCI variables

Configure these variables in the `aws-dev` CircleCI context:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_SESSION_TOKEN` when using temporary credentials
- `AWS_REGION`
- `AWS_ACCOUNT_ID`

The AWS SDK and CDK read the exported AWS credentials directly from the process environment. No credentials are stored in `manifest.yml`.# datacontract-service
