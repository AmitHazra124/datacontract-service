import { DynamoDBClient, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const dynamodb = new DynamoDBClient({});

export async function handler(request: { datacontractId: string; status: string; stackName: string }) {
  await dynamodb.send(new UpdateItemCommand({
    TableName: process.env.DATACONTRACTS_TABLE_NAME,
    Key: { id: { S: request.datacontractId } },
    UpdateExpression: 'SET #status = :status, #operation = :status, updatedAt = :updatedAt, stackName = :stackName',
    ExpressionAttributeNames: { '#status': 'status', '#operation': 'operation' },
    ExpressionAttributeValues: {
      ':status': { S: request.status },
      ':updatedAt': { S: new Date().toISOString() },
      ':stackName': { S: request.stackName },
    },
  }));
  return request;
}
