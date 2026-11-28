import { handler as artifactHandler } from '../integrationArtifactLambda/integration-artifact';
import { handler as provisionHandler } from '../provisionLambda/provision-stack';
import { handler as statusHandler } from '../statusLambda/update-status';

type WorkflowRequest = {
  action: 'prepare' | 'package' | 'provision' | 'status';
  [key: string]: unknown;
};

/** Routes each Step Functions task to the relevant workflow operation. */
export async function handler(request: WorkflowRequest) {
  switch (request?.action) {
    case 'prepare':
    case 'package':
      return artifactHandler(request as never);
    case 'provision':
      return provisionHandler(request as never);
    case 'status':
      return statusHandler(request as never);
    default:
      throw new Error('Unsupported workflow action.');
  }
}
