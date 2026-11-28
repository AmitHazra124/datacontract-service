import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNodejs from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import { readFileSync } from "node:fs";

export class DatacontractServiceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const integrationCodeBucket = new s3.Bucket(this, "IntegrationCodeBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new s3deploy.BucketDeployment(this, "IntegrationCodeDeployment", {
      sources: [s3deploy.Source.asset("dist")],
      destinationBucket: integrationCodeBucket,
      destinationKeyPrefix: "integration-lambda",
      prune: false,
    });

    new s3deploy.BucketDeployment(this, "IntegrationArtifactDeployment", {
      sources: [s3deploy.Source.asset("dist-ia")],
      destinationBucket: integrationCodeBucket,
      destinationKeyPrefix: "integration-artifact",
      prune: false,
    });

    const datacontractsTable = new dynamodb.Table(this, "DatacontractsTable", {
      tableName: "datacontracts",
      partitionKey: { name: "id", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const integrationTemplate = readFileSync("infra/template.json", "utf8");

    // One worker Lambda handles all Step Functions work. The API Lambda stays
    // separate so its execution role does not need CloudFormation permissions.
    const workflowHandler = new lambdaNodejs.NodejsFunction(
      this,
      "DatacontractWorkflowHandler",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: "src/workflowLambda/workflow-handler.ts",
        depsLockFilePath: "yarn.lock",
        timeout: cdk.Duration.minutes(2),
        memorySize: 512,
        environment: { DATACONTRACTS_TABLE_NAME: datacontractsTable.tableName },
      },
    );
    integrationCodeBucket.grantReadWrite(workflowHandler);
    datacontractsTable.grantWriteData(workflowHandler);
    workflowHandler.addEnvironment("STACK_NAME_PREFIX", `${this.stackName}-`);
    workflowHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cloudformation:CreateStack",
          "cloudformation:UpdateStack",
          "cloudformation:DeleteStack",
          "cloudformation:DescribeStacks",
        ],
        resources: ["*"],
      }),
    );
    workflowHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:*"],
        resources: [
          `arn:${this.partition}:iam::${this.account}:role/${this.stackName}-*`,
        ],
      }),
    );
    workflowHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["lambda:*"],
        resources: [
          `arn:${this.partition}:lambda:${this.region}:${this.account}:function:${this.stackName}-*`,
        ],
      }),
    );
    workflowHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "lambda:CreateEventSourceMapping",
          "lambda:GetEventSourceMapping",
          "lambda:UpdateEventSourceMapping",
          "lambda:DeleteEventSourceMapping",
        ],
        resources: ["*"],
      }),
    );
    workflowHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["kinesis:*"],
        resources: [
          `arn:${this.partition}:kinesis:${this.region}:${this.account}:stream/${this.stackName}-*`,
        ],
      }),
    );
    workflowHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iot:*"],
        resources: ["*"],
      }),
    );
    const prepareArtifact = new tasks.LambdaInvoke(
      this,
      "PrepareIntegrationAdapterFiles",
      {
        lambdaFunction: workflowHandler,
        payloadResponseOnly: true,
        payload: sfn.TaskInput.fromObject({
          action: "prepare",
          datacontractId: sfn.JsonPath.stringAt("$.datacontractId"),
          datacontract: sfn.JsonPath.objectAt("$"),
          sourceBucket: integrationCodeBucket.bucketName,
          sourceKey: "integration-lambda/index.js",
          destinationBucket: integrationCodeBucket.bucketName,
        }),
        resultPath: "$.artifact",
      },
    );

    const packageArtifact = new tasks.LambdaInvoke(
      this,
      "PackageIntegrationAdapter",
      {
        lambdaFunction: workflowHandler,
        payloadResponseOnly: true,
        payload: sfn.TaskInput.fromObject({
          action: "package",
          datacontractId: sfn.JsonPath.stringAt("$.datacontractId"),
          datacontract: sfn.JsonPath.objectAt("$"),
          sourceBucket: integrationCodeBucket.bucketName,
          sourceKey: "integration-lambda/index.js",
          destinationBucket: integrationCodeBucket.bucketName,
        }),
        resultPath: "$.artifact",
      },
    );
    const provisionStack = new tasks.LambdaInvoke(
      this,
      "CreateIntegrationAdapterStack",
      {
        lambdaFunction: workflowHandler,
        payloadResponseOnly: true,
        payload: sfn.TaskInput.fromObject({
          action: "provision",
          operation: sfn.JsonPath.stringAt("$.operation"),
          provider: sfn.JsonPath.stringAt("$.provider"),
          datacontractId: sfn.JsonPath.stringAt("$.datacontractId"),
          templateBody: integrationTemplate,
          artifactBucket: sfn.JsonPath.stringAt("$.artifact.artifactBucket"),
          artifactKey: sfn.JsonPath.stringAt("$.artifact.artifactKey"),
        }),
        resultPath: "$.provisioning",
      },
    );
    const updateStatus = new tasks.LambdaInvoke(
      this,
      "RecordProvisioningStatus",
      {
        lambdaFunction: workflowHandler,
        payloadResponseOnly: true,
        payload: sfn.TaskInput.fromObject({
          action: "status",
          datacontractId: sfn.JsonPath.stringAt("$.datacontractId"),
          stackName: sfn.JsonPath.stringAt("$.provisioning.stackName"),
          status: sfn.JsonPath.stringAt("$.provisioning.status"),
        }),
        resultPath: "$.status",
      },
    );

    const workflow = new sfn.StateMachine(this, "DataContractStepFunction", {
      definitionBody: sfn.DefinitionBody.fromChainable(
        prepareArtifact
          .next(packageArtifact)
          .next(provisionStack)
          .next(updateStatus),
      ),
      timeout: cdk.Duration.minutes(15),
    });

    const apiHandlerLambda = new lambdaNodejs.NodejsFunction(
      this,
      "ApiHandlerLambda",
      {
        runtime: lambda.Runtime.NODEJS_22_X,
        entry: "src/apihandlerLambda/apihandlerLambda.ts",
        depsLockFilePath: "yarn.lock",
        timeout: cdk.Duration.seconds(15),
        environment: {
          STATE_MACHINE_ARN: workflow.stateMachineArn,
          DATACONTRACTS_TABLE_NAME: datacontractsTable.tableName,
        },
      },
    );

    const api = new apigateway.RestApi(this, "DataContractApi", {
      restApiName: "datacontract-service-api",
      deployOptions: { stageName: "v1" },
    });

    const stackResource = api.root.addResource("stacks");

    const contractResource = stackResource.addResource("{datacontractId}");
    contractResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(apiHandlerLambda),
    );
    contractResource.addMethod(
      "PUT",
      new apigateway.LambdaIntegration(apiHandlerLambda),
    );
    contractResource.addMethod(
      "PATCH",
      new apigateway.LambdaIntegration(apiHandlerLambda),
    );
    contractResource.addMethod(
      "DELETE",
      new apigateway.LambdaIntegration(apiHandlerLambda),
    );
    stackResource.addMethod(
      "GET",
      new apigateway.LambdaIntegration(apiHandlerLambda),
    );

    stackResource.addMethod(
      "POST",
      new apigateway.LambdaIntegration(apiHandlerLambda),
    );

    workflow.grantStartExecution(apiHandlerLambda);
    datacontractsTable.grantWriteData(apiHandlerLambda);
    datacontractsTable.grantReadData(apiHandlerLambda);

    new cdk.CfnOutput(this, "ApiUrl", { value: api.urlForPath("/stacks") });
    new cdk.CfnOutput(this, "StateMachineArn", {
      value: workflow.stateMachineArn,
    });
    new cdk.CfnOutput(this, "IntegrationCodeBucketName", {
      value: integrationCodeBucket.bucketName,
    });
    new cdk.CfnOutput(this, "IntegrationCodeObjectKey", {
      value: "integration-lambda/index.js",
    });
    new cdk.CfnOutput(this, "IntegrationArtifactObjectKey", {
      value: "integration-artifact/index.js",
    });
    new cdk.CfnOutput(this, "DatacontractsTableName", {
      value: datacontractsTable.tableName,
    });
  }
}
