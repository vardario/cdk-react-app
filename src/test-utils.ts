import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { Construct } from 'constructs';

export const MOCK_CERT_ARN = 'arn:aws:acm:eu-central-1:123456789012:certificate/guid';
export const MOCK_SECRET_ARN = 'arn:aws:secretsmanager:eu-central-1:123456789012:secret:dev/service_credentials-PM8hBD';

export function runConstructTest<Props>(
  construct: new (stack: cdk.Stack, id: string, props: Props) => Construct,
  test: (template: Template) => void,
  props: (stack: cdk.Stack) => Props
) {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'Stack');

  new construct(stack, 'Construct', props(stack));

  const template = Template.fromStack(stack);

  test(template);
}
