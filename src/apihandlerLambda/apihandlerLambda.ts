import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { randomUUID } from "node:crypto";

const dynamodb = new DynamoDBClient({});
const stepFunctions = new SFNClient({});

type ContractPayload = Record<string, unknown> & { provider: string };
type ProvisionOperation = "create" | "update" | "delete";

function jsonResponse(
  statusCode: number,
  body: Record<string, unknown>,
): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function contractResponse(item: Record<string, AttributeValue>): Record<string, unknown> {
  let payload: unknown = item.payload?.S ?? null;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      // Keep the stored string visible if a legacy row contains invalid JSON.
    }
  }

  return {
    id: item.id?.S,
    provider: item.provider?.S,
    operation: item.operation?.S,
    status: item.status?.S,
    stackName: item.stackName?.S,
    createdAt: item.createdAt?.S,
    updatedAt: item.updatedAt?.S,
    payload,
  };
}

function validateProvider(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const provider = value.trim();
  return /^[A-Za-z0-9-]{1,25}$/.test(provider) ? provider : undefined;
}

async function findContract(
  tableName: string,
  datacontractId: string,
): Promise<Record<string, AttributeValue> | undefined> {
  const result = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: { id: { S: datacontractId } },
      ConsistentRead: true,
    }),
  );
  return result.Item;
}

function readStoredPayload(
  item: Record<string, AttributeValue>,
): ContractPayload | undefined {
  const storedPayload = item.payload?.S;
  if (!storedPayload) return undefined;

  try {
    const parsed: unknown = JSON.parse(storedPayload);
    if (!isJsonObject(parsed) || typeof parsed.provider !== "string") {
      return undefined;
    }
    return parsed as ContractPayload;
  } catch {
    return undefined;
  }
}

async function startProvisioning(
  stateMachineArn: string,
  datacontractId: string,
  payload: ContractPayload,
  operation: ProvisionOperation,
): Promise<string | undefined> {
  const execution = await stepFunctions.send(
    new StartExecutionCommand({
      stateMachineArn,
      name: `provision-${randomUUID()}`,
      input: JSON.stringify({ ...payload, operation, datacontractId }),
    }),
  );
  return execution.executionArn;
}

async function markProvisioningStartFailed(
  tableName: string,
  datacontractId: string,
  operation: ProvisionOperation,
): Promise<void> {
  await dynamodb.send(
    new UpdateItemCommand({
      TableName: tableName,
      Key: { id: { S: datacontractId } },
      UpdateExpression:
        "SET #status = :status, #operation = :operation, updatedAt = :updatedAt",
      ExpressionAttributeNames: {
        "#status": "status",
        "#operation": "operation",
      },
      ExpressionAttributeValues: {
        ":status": { S: "START_FAILED" },
        ":operation": { S: `${operation.toUpperCase()}_START_FAILED` },
        ":updatedAt": { S: new Date().toISOString() },
      },
    }),
  );
}

function readJsonBody(event: APIGatewayProxyEvent): unknown {
  const body = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body;
  return body ? JSON.parse(body) : {};
}

export async function handler(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod?.toUpperCase();
  const supportedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  if (!method || !supportedMethods.includes(method)) {
    return jsonResponse(405, { message: "Method not allowed." });
  }

  const tableName = process.env.DATACONTRACTS_TABLE_NAME;
  if (!tableName) {
    console.error("DATACONTRACTS_TABLE_NAME is not configured.");
    return jsonResponse(500, { message: "Service is not configured correctly." });
  }

  if (method === "GET") {
    const datacontractId = event.pathParameters?.datacontractId;

    try {
      if (!datacontractId) {
        const items: Record<string, AttributeValue>[] = [];
        let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

        do {
          const page = await dynamodb.send(
            new ScanCommand({
              TableName: tableName,
              ExclusiveStartKey: lastEvaluatedKey,
            }),
          );
          items.push(...(page.Items ?? []));
          lastEvaluatedKey = page.LastEvaluatedKey;
        } while (lastEvaluatedKey);

        return jsonResponse(200, { items: items.map(contractResponse) });
      }

      const item = await findContract(tableName, datacontractId);
      if (!item) {
        return jsonResponse(404, { message: "Data contract not found." });
      }
      return jsonResponse(200, contractResponse(item));
    } catch (error) {
      console.error("Failed to read data contracts.", error);
      return jsonResponse(500, { message: "Could not read data contracts." });
    }
  }

  if (method === "POST" || method === "PUT" || method === "PATCH") {
    let request: unknown;
    try {
      request = readJsonBody(event);
    } catch {
      return jsonResponse(400, { message: "Request body must be valid JSON." });
    }
    if (!isJsonObject(request)) {
      return jsonResponse(400, { message: "Request body must be a JSON object." });
    }

    if (method === "POST") {
      const provider = validateProvider(request.provider);
      if (!provider) {
        return jsonResponse(400, {
          message:
            "provider is required and must contain only letters, numbers, and hyphens (up to 25 characters).",
        });
      }

      const stateMachineArn = process.env.STATE_MACHINE_ARN;
      if (!stateMachineArn) {
        console.error("STATE_MACHINE_ARN is not configured.");
        return jsonResponse(500, { message: "Service is not configured correctly." });
      }

      const datacontract: ContractPayload = { ...request, provider };
      const datacontractId = randomUUID();
      const now = new Date().toISOString();

      try {
        await dynamodb.send(
          new PutItemCommand({
            TableName: tableName,
            Item: {
              id: { S: datacontractId },
              provider: { S: provider },
              operation: { S: "CREATE_PENDING" },
              status: { S: "PENDING" },
              payload: { S: JSON.stringify(datacontract) },
              createdAt: { S: now },
              updatedAt: { S: now },
            },
            ConditionExpression: "attribute_not_exists(id)",
          }),
        );
      } catch (error) {
        console.error("Failed to save the data contract.", error);
        return jsonResponse(500, { message: "Could not save the data contract." });
      }

      try {
        const executionArn = await startProvisioning(
          stateMachineArn,
          datacontractId,
          datacontract,
          "create",
        );
        return jsonResponse(202, {
          datacontractId,
          executionArn,
          operation: "create",
          status: "PENDING",
        });
      } catch (error) {
        console.error("Failed to start the create workflow.", error);
        try {
          await markProvisioningStartFailed(tableName, datacontractId, "create");
        } catch (statusError) {
          console.error("Failed to record the workflow start failure.", statusError);
        }
        return jsonResponse(500, {
          message: "The data contract was saved, but provisioning could not be started.",
          datacontractId,
        });
      }
    }

    const datacontractId = event.pathParameters?.datacontractId;
    if (!datacontractId) {
      return jsonResponse(400, { message: "datacontractId is required in the URL." });
    }

    let existingItem: Record<string, AttributeValue> | undefined;
    try {
      existingItem = await findContract(tableName, datacontractId);
    } catch (error) {
      console.error("Failed to find the data contract.", error);
      return jsonResponse(500, { message: "Could not read the data contract." });
    }
    if (!existingItem) {
      return jsonResponse(404, { message: "Data contract not found." });
    }
    const currentPayload = readStoredPayload(existingItem);
    const currentProvider = existingItem.provider?.S ?? currentPayload?.provider;
    if (!currentPayload || !currentProvider) {
      return jsonResponse(500, { message: "Stored data contract is invalid." });
    }

    let nextPayload: ContractPayload;
    if (method === "PUT") {
      const provider = validateProvider(request.provider);
      if (!provider) {
        return jsonResponse(400, {
          message: "PUT requires a valid provider (up to 25 letters, numbers, or hyphens).",
        });
      }
      if (provider !== currentProvider) {
        return jsonResponse(400, {
          message: "provider cannot be changed because it determines the CloudFormation stack name.",
        });
      }
      nextPayload = { ...request, provider };
    } else {
      if (
        request.provider !== undefined &&
        (typeof request.provider !== "string" || request.provider.trim() !== currentProvider)
      ) {
        return jsonResponse(400, { message: "provider cannot be changed by PATCH." });
      }
      nextPayload = { ...currentPayload, ...request, provider: currentProvider };
      if (Object.keys(request).length === 0) {
        return jsonResponse(400, { message: "PATCH requires at least one field." });
      }
    }

    const stateMachineArn = process.env.STATE_MACHINE_ARN;
    if (!stateMachineArn) {
      console.error("STATE_MACHINE_ARN is not configured.");
      return jsonResponse(500, { message: "Service is not configured correctly." });
    }

    const now = new Date().toISOString();
    try {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { id: { S: datacontractId } },
          UpdateExpression:
            "SET payload = :payload, #operation = :operation, #status = :status, updatedAt = :updatedAt",
          ExpressionAttributeNames: {
            "#operation": "operation",
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":payload": { S: JSON.stringify(nextPayload) },
            ":operation": { S: "UPDATE_PENDING" },
            ":status": { S: "PENDING" },
            ":updatedAt": { S: now },
          },
          ConditionExpression: "attribute_exists(id)",
        }),
      );
    } catch (error) {
      console.error("Failed to update the data contract.", error);
      return jsonResponse(500, { message: "Could not update the data contract." });
    }

    try {
      const executionArn = await startProvisioning(
        stateMachineArn,
        datacontractId,
        nextPayload,
        "update",
      );
      return jsonResponse(202, {
        datacontractId,
        executionArn,
        operation: "update",
        status: "PENDING",
      });
    } catch (error) {
      console.error("Failed to start the update workflow.", error);
      try {
        await markProvisioningStartFailed(tableName, datacontractId, "update");
      } catch (statusError) {
        console.error("Failed to record the workflow start failure.", statusError);
      }
      return jsonResponse(500, {
        message: "The data contract was updated, but provisioning could not be started.",
        datacontractId,
      });
    }
  }

  if (method === "DELETE") {
    const datacontractId = event.pathParameters?.datacontractId;
    if (!datacontractId) {
      return jsonResponse(400, { message: "datacontractId is required in the URL." });
    }

    let existingItem: Record<string, AttributeValue> | undefined;
    try {
      existingItem = await findContract(tableName, datacontractId);
    } catch (error) {
      console.error("Failed to find the data contract.", error);
      return jsonResponse(500, { message: "Could not read the data contract." });
    }
    if (!existingItem) {
      return jsonResponse(404, { message: "Data contract not found." });
    }
    const payload = readStoredPayload(existingItem);
    if (!payload) {
      return jsonResponse(500, { message: "Stored data contract is invalid." });
    }

    const stateMachineArn = process.env.STATE_MACHINE_ARN;
    if (!stateMachineArn) {
      console.error("STATE_MACHINE_ARN is not configured.");
      return jsonResponse(500, { message: "Service is not configured correctly." });
    }

    try {
      await dynamodb.send(
        new UpdateItemCommand({
          TableName: tableName,
          Key: { id: { S: datacontractId } },
          UpdateExpression:
            "SET #operation = :operation, #status = :status, updatedAt = :updatedAt",
          ExpressionAttributeNames: {
            "#operation": "operation",
            "#status": "status",
          },
          ExpressionAttributeValues: {
            ":operation": { S: "DELETE_PENDING" },
            ":status": { S: "PENDING" },
            ":updatedAt": { S: new Date().toISOString() },
          },
          ConditionExpression: "attribute_exists(id)",
        }),
      );
    } catch (error) {
      console.error("Failed to mark the data contract for deletion.", error);
      return jsonResponse(500, { message: "Could not start deleting the data contract." });
    }

    try {
      const executionArn = await startProvisioning(
        stateMachineArn,
        datacontractId,
        payload,
        "delete",
      );
      return jsonResponse(202, {
        datacontractId,
        executionArn,
        operation: "delete",
        status: "PENDING",
      });
    } catch (error) {
      console.error("Failed to start the delete workflow.", error);
      try {
        await markProvisioningStartFailed(tableName, datacontractId, "delete");
      } catch (statusError) {
        console.error("Failed to record the workflow start failure.", statusError);
      }
      return jsonResponse(500, {
        message: "The data contract was marked for deletion, but provisioning could not be started.",
        datacontractId,
      });
    }
  }

  return jsonResponse(405, { message: "Method not allowed." });
}
