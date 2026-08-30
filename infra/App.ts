#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DatacontractServiceStack } from './stacks/datacontract-service-stack';
import { loadManifestEnvironment } from './manifest';

const app = new cdk.App();
const environment = loadManifestEnvironment();

new DatacontractServiceStack(app, 'DatacontractServiceStack', {
	env: environment,
});
