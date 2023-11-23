import * as cdk from 'aws-cdk-lib';
import { RemovalPolicy } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { MOCK_CERT_ARN, runConstructTest } from './test-utils.js';
import { ReactApp, ReactAppConstructProps } from './react-app.js';

function runTest(
  test: (template: Template) => void,
  props: (stack: cdk.Stack) => Omit<ReactAppConstructProps, 'doNotBuild' | 'doNotUpload' | 'frontendPath'>
) {
  runConstructTest(ReactApp, test, stack => {
    return {
      ...props(stack),
      doNotBuild: true,
      doNotUpload: true,
      frontendPath: ''
    };
  });
}

describe('react-app construct', () => {
  const bucketName = 'react-app';
  const domainName = 'react-app.com';
  const domainCertificateArn = MOCK_CERT_ARN;
  const hostedZoneId = 'Z1234567VOKGW0L12345';

  test('Basic setup', () => {
    runTest(
      template => {
        template.hasResourceProperties('AWS::S3::Bucket', {
          BucketName: bucketName,
          WebsiteConfiguration: {
            IndexDocument: 'index.html',
            ErrorDocument: 'index.html'
          }
        });

        template.hasResourceProperties('Custom::CDKBucketDeployment', {
          Prune: false,
          SystemMetadata: {
            'cache-control': 'max-age=0, no-cache, no-store, must-revalidate'
          }
        });

        template.hasResourceProperties('Custom::CDKBucketDeployment', {
          Prune: false
        });

        template.hasResource('AWS::S3::Bucket', {
          UpdateReplacePolicy: 'Delete',
          DeletionPolicy: 'Delete'
        });
      },
      () => ({
        bucketName
      })
    );

    runTest(
      template => {
        template.hasResource('AWS::S3::Bucket', {
          UpdateReplacePolicy: 'Retain',
          DeletionPolicy: 'Retain'
        });
      },
      () => ({
        bucketName,
        removalPolicy: RemovalPolicy.RETAIN
      })
    );
  });

  test('With Config generation', () => {
    runTest(
      template => {
        template.hasResource('Custom::AWS', {});
      },
      () => ({
        bucketName,
        config: {}
      })
    );
  });

  test('With Cloudfront', () => {
    runTest(
      template => {
        /**
         * Since we are using a CloudFront distribution,
         * we except not public access to the backing S3 Bucket
         */

        template.hasResourceProperties('AWS::S3::Bucket', {
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            BlockPublicPolicy: true,
            IgnorePublicAcls: true,
            RestrictPublicBuckets: true
          }
        });

        template.hasResource('AWS::CloudFront::CloudFrontOriginAccessIdentity', {});

        template.hasResourceProperties('AWS::CloudFront::Distribution', {
          DistributionConfig: {
            CustomErrorResponses: [
              {
                ErrorCode: 403,
                ResponseCode: 200,
                ResponsePagePath: '/'
              },
              {
                ErrorCode: 404,
                ResponseCode: 200,
                ResponsePagePath: '/'
              }
            ],
            DefaultRootObject: 'index.html',
            ViewerCertificate: {
              CloudFrontDefaultCertificate: true
            }
          }
        });
      },
      () => ({ bucketName, withCloudfrontDistribution: true })
    );
  });

  test('With Domain', () => {
    runTest(
      template => {
        template.hasResourceProperties('AWS::Route53::RecordSet', {
          Name: `${domainName}.`,
          Type: 'A',
          HostedZoneId: hostedZoneId
        });

        template.hasResourceProperties('AWS::CloudFront::Distribution', {
          DistributionConfig: {
            Aliases: [domainName],
            ViewerCertificate: {
              AcmCertificateArn: domainCertificateArn
            }
          }
        });
      },
      stack => ({
        bucketName,
        domain: {
          domainName,
          domainCertificateArn,
          hostedZone: cdk.aws_route53.HostedZone.fromHostedZoneAttributes(stack, 'hostedZone', {
            zoneName: domainName,
            hostedZoneId: hostedZoneId
          })
        }
      })
    );
  });
});
