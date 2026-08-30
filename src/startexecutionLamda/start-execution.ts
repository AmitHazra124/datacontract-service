import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { randomUUID } from 'node:crypto';

const dynamodb = new DynamoDBClient({});
const client = new SFNClient({});

type DatacontractPayload = {
  stackName: string;
  templateBody: string;
  parameters?: Record<string, string>;
  capabilities?: string[];
  [key: string]: unknown;
};

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : event.body;

  let request: unknown;
  try {
    request = body ? JSON.parse(body) : {};
  } catch {
    return { statusCode: 400, body: JSON.stringify({ message: 'Request body must be valid JSON.' }) };
  }

  if (typeof request == "object" && request && Object.keys(request).length > 0 && !(request as { provider: string })?.provider) {
    return { statusCode: 400, body: JSON.stringify({ message: 'stackName is required.' }) };
  }

  const operationByMethod: Record<string, string> = {
    POST: 'create',
    GET: 'get',
    PUT: 'update',
    DELETE: 'delete',
  };
  const operationStatus: Record<string, string> = {
    CREATE_PENDING: 'CREATE_PENDING',
    CREATE_IN_PROGRESS: 'CREATE_IN_PROGRESS',
    CREATE_COMPLETE: 'CREATE_COMPLETE',
    CREATE_FAILED: 'CREATE_FAILED',

    UPDATE_PENDING: 'UPDATE_PENDING',
    UPDATE_IN_PROGRESS: 'UPDATE_IN_PROGRESS',
    UPDATE_COMPLETE: 'UPDATE_COMPLETE',
    UPDATE_FAILED: 'UPDATE_FAILED',

    DELETE_PENDING: 'DELETE_PENDING',
    DELETE_IN_PROGRESS: 'DELETE_IN_PROGRESS',
    DELETE_COMPLETE: 'DELETE_COMPLETE',
    DELETE_FAILED: 'DELETE_FAILED',
  }

  const operation = operationByMethod[event.httpMethod.toUpperCase()];
  if (!operation) {
    return { statusCode: 400, body: JSON.stringify({ message: 'Unsupported stack operation.' }) };
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  if (operation === 'create') {
    await dynamodb.send(new PutItemCommand({
      TableName: process.env.DATACONTRACTS_TABLE_NAME,
      Item: {
        id: { S: id },
        provider: { S: (request as { provider: string }).provider },
        operation: { S: operationStatus[`${operation.toUpperCase()}_PENDING`] },
        status: { S: 'PENDING' },
        payload: { S: JSON.stringify(request) },
        createdAt: { S: now },
        updatedAt: { S: now },
      },
    }));
  }

  const payload = {
    ...(typeof request === 'object' && request !== null ? request : {}),
    operation,
    datacontractId: id,
  };
  const execution = await client.send(new StartExecutionCommand({
    stateMachineArn: process.env.STATE_MACHINE_ARN,
    name: `provision-${randomUUID()}`,
    input: JSON.stringify(payload),
  }));
  return {
    statusCode: 202,
    body: JSON.stringify({ datacontractId: id, executionArn: execution.executionArn, operation }),
  };
}