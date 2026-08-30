import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  DescribeStacksCommand,
  UpdateStackCommand,
} from '@aws-sdk/client-cloudformation';
import type { Capability } from '@aws-sdk/client-cloudformation';

const client = new CloudFormationClient({});

type ProvisionRequest = {
  provider?: string;
  messageType?: string;
  equipmentFamily?: string;
  nodeId?: string;
  deviceId?: string;
  operation: 'create' | 'get' | 'update' | 'delete'; 
  datacontractId?: string;
  templateBody: string;
  artifactBucket?: string;
  artifactKey?: string;
};



export async function handler(request: ProvisionRequest) {
  if (!request?.operation || !request.provider) {
    throw new Error('operation and provider are required.');
  }
  const stackName = `${process.env.STACK_NAME_PREFIX ?? ''}${request.provider}`;
  if (
    request.operation !== 'delete'
    && request.operation !== 'get'
    && (!request.artifactBucket || !request.artifactKey)
  ) {
    throw new Error('artifact is required for create and update.');
  }
  const parameters = [{
    ParameterKey: 'IoTTopicName',
    ParameterValue: `datacontracts/${request.datacontractId ?? request.provider}/ingest`,
  }];
  const templateBody = request.templateBody
    .replaceAll('${INTEGRATION_CODE_BUCKET}', request.artifactBucket ?? '')
    .replaceAll('${INTEGRATION_CODE_KEY}', request.artifactKey ?? '');
  const common = {
    StackName: stackName,
    Parameters: parameters,
    Capabilities: ['CAPABILITY_NAMED_IAM'] as Capability[],
  };
  if (request.operation === 'get') {
    const details = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    return { operation: request.operation, stackId: details.Stacks?.[0]?.StackId, status: details.Stacks?.[0]?.StackStatus, stackName };
  }

  let result: { StackId?: string };
  if (request.operation === 'create') {
    result = await client.send(new CreateStackCommand({
      ...common,
      TemplateBody: templateBody,
      OnFailure: 'DELETE',
    }));
  } else if (request.operation === 'update') {
    result = await client.send(new UpdateStackCommand({
      ...common,
      TemplateBody: templateBody,
    }));
  } else {
    await client.send(new DeleteStackCommand({ StackName: stackName }));
    return { operation: request.operation, stackName, status: 'DELETE_IN_PROGRESS' };
  }
  const details = await client.send(new DescribeStacksCommand({ StackName: stackName }));
  return { operation: request.operation, stackId: result.StackId, status: details.Stacks?.[0]?.StackStatus, stackName };
}