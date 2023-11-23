import { RemovalPolicy, Stack } from 'aws-cdk-lib';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cf from 'aws-cdk-lib/aws-cloudfront';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3d from 'aws-cdk-lib/aws-s3-deployment';
import * as cm from 'aws-cdk-lib/aws-certificatemanager';
import * as r53 from 'aws-cdk-lib/aws-route53';
import * as r53t from 'aws-cdk-lib/aws-route53-targets';

import { AwsCustomResource, AwsCustomResourcePolicy, PhysicalResourceId } from 'aws-cdk-lib/custom-resources';
import { execSync } from 'node:child_process';
import { Construct } from 'constructs';
import * as path from 'node:path';

export interface ReactAppConstructProps {
  /**
   * The name for the backing s3 Bucket.
   *
   * Remarks
   *  In case you define a @see domainName, the name of the bucket will be
   *  the same as @see domainName
   */
  bucketName: string;

  /**
   * Build command to run inside the @see frontendPath.
   * If omitted defaults to `npm run build`
   */
  buildCommand?: string;

  /**
   * Optional config object which will be used to generate a `config.json` file
   * in the root of the ReactApp deployment.
   *
   * This object will be converted to json and can include deploy-time dependent values
   * which will be resolved before creating the `config.json`.
   *
   * An example for a config object with deploy-time dependent values can look like this.
   *
   * @example
   *
   * config: {
   *   userPoolId: apiStack.userPoolId.value,
   *   userPoolWebClientId: apiStack.userPoolWebClientId.value,
   *   apiV1: apiStack.domainApiUrl.value
   * }
   */
  config?: any;

  /**
   * By default this construct will build the react app on synth time.
   * For debug and test purposes it could be beneficial to not build the react-app
   * on each synth.
   */
  doNotBuild?: boolean;

  /**
   * When set, there will be no upload to the backing S3 bucket.
   * Can be useful for testing, debugging or a dry run.
   */
  doNotUpload?: boolean;

  /**
   * When specifying the `domain` prop, this construct will also create a `CloudFrond` distribution and will
   * create the Route53 records for the domain and will take care to connect the provided SSL certificates.
   */
  domain?: {
    /**
     * Aliases under which the app is also available.
     * The given certificate has to support the additional aliases as well.
     */
    aliases?: string[];

    /**
     * ARN to a certificate which will be used for the underlying CloudFront distribution.
     *
     * Remarks
     *  1. Certificate has to be deployed in us-east-1
     *  2. Certificate has to be compatible with the given @see domainName .
     */
    domainCertificateArn: string;

    /**
     * Fully qualified domain name under which the react app will be available.
     */
    domainName: string;

    /**
     * Reference to a hosted zone compatible with the given @see domainName .
     */
    hostedZone: r53.IHostedZone;
  };

  /**
   * Absolute path to which the react app is build to.
   * If omitted defaults to `frontendPath`/build
   */
  frontendBuildPath?: string;

  /**
   * Absolute path to a react app project.
   */
  frontendPath: string;

  /**
   * Defaults to @see RemovalPolicy.DESTROY
   */
  removalPolicy?: RemovalPolicy;

  /**
   * With this option set, there will be also a CloudFront distribution setup.
   * In case a @see domain is defined, this will be automatically true.
   */
  withCloudfrontDistribution?: true;
}
/**
 * ReactApp deployment construct which takes care to
 * build a given react app on synth, deploy it into a S3 bucket
 * and back it by a Cloudfront distribution when desired.
 *
 * The construct takes care to deploy the react app where the `index.html` is never cached by the browser.
 * Consecutive deployments do not prune the previous S3 content.
 */
export class ReactApp extends Construct {
  public readonly webAppBucket: s3.Bucket;
  public readonly webDistribution?: cf.CloudFrontWebDistribution;

  constructor(
    scope: Construct,
    id: string,
    {
      frontendPath,
      frontendBuildPath,
      config,
      buildCommand,
      domain,
      bucketName,
      doNotBuild,
      doNotUpload,
      withCloudfrontDistribution,
      removalPolicy
    }: ReactAppConstructProps
  ) {
    super(scope, id);

    buildCommand = buildCommand || 'npm run build';
    frontendBuildPath = frontendBuildPath || path.resolve(frontendPath, 'build');
    bucketName = (domain && domain.domainName) || bucketName;
    withCloudfrontDistribution = withCloudfrontDistribution || (domain && true);
    removalPolicy = removalPolicy || RemovalPolicy.DESTROY;

    if (!doNotBuild) {
      try {
        console.log(`Building static site ${frontendPath}`);
        execSync(buildCommand, {
          cwd: frontendPath,
          stdio: 'inherit'
        });
      } catch (e) {
        throw new Error(`There was a problem building the "${this.node.id}" ReactApp.`);
      }
    }

    this.webAppBucket = new s3.Bucket(this, `${bucketName}_Bucket`, {
      bucketName,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      removalPolicy,
      publicReadAccess: withCloudfrontDistribution ? false : true,
      blockPublicAccess: withCloudfrontDistribution ? s3.BlockPublicAccess.BLOCK_ALL : undefined,
      autoDeleteObjects: removalPolicy === RemovalPolicy.DESTROY
    });

    if (withCloudfrontDistribution) {
      const cloudfrontOAIforUserApp = new cf.OriginAccessIdentity(this, 'cloudfront-OAI', {
        comment: `OAI for ${bucketName}`
      });
      this.webAppBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [this.webAppBucket.arnForObjects('*')],
          principals: [
            new iam.CanonicalUserPrincipal(cloudfrontOAIforUserApp.cloudFrontOriginAccessIdentityS3CanonicalUserId)
          ]
        })
      );

      const certificate = domain && cm.Certificate.fromCertificateArn(this, 'Certificate', domain.domainCertificateArn);

      this.webDistribution = new cf.CloudFrontWebDistribution(this, `${bucketName}_Distribution}`, {
        viewerCertificate:
          domain &&
          certificate &&
          cf.ViewerCertificate.fromAcmCertificate(certificate, {
            aliases: [domain.domainName, ...(domain.aliases || [])]
          }),
        viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        originConfigs: [
          {
            s3OriginSource: {
              s3BucketSource: this.webAppBucket,
              originAccessIdentity: cloudfrontOAIforUserApp
            },
            behaviors: [{ isDefaultBehavior: true }]
          }
        ],
        errorConfigurations: [
          { errorCode: 403, responseCode: 200, responsePagePath: '/' },
          { errorCode: 404, responseCode: 200, responsePagePath: '/' }
        ]
      });

      const record =
        domain &&
        new r53.ARecord(this, `${domain.domainName}_Alias}`, {
          recordName: domain.domainName,
          target: r53.RecordTarget.fromAlias(new r53t.CloudFrontTarget(this.webDistribution)),
          zone: domain.hostedZone
        });
    }

    new s3d.BucketDeployment(this, `${bucketName}_Deployment_Assets`, {
      destinationBucket: this.webAppBucket,
      sources:
        (!doNotUpload && [
          s3d.Source.asset(frontendBuildPath, {
            exclude: ['index.html', 'config.json']
          })
        ]) ||
        [],
      prune: false
    });

    new s3d.BucketDeployment(this, `${bucketName}_Deployment_Index`, {
      destinationBucket: this.webAppBucket,
      sources:
        (!doNotUpload && [
          s3d.Source.asset(frontendBuildPath, {
            exclude: ['*', '!index.html']
          })
        ]) ||
        [],
      cacheControl: [s3d.CacheControl.fromString('max-age=0, no-cache, no-store, must-revalidate')],
      prune: false
    });

    if (config !== undefined) {
      new AwsCustomResource(this, `${bucketName}_config.json`, {
        logRetention: RetentionDays.ONE_DAY,
        onUpdate: {
          action: 'putObject',
          parameters: {
            Body: Stack.of(this).toJsonString(config),
            Bucket: this.webAppBucket.bucketName,
            CacheControl: 'max-age=0, no-cache, no-store, must-revalidate',
            ContentType: 'application/json',
            Key: 'config.json'
          },
          physicalResourceId: PhysicalResourceId.of('config'),
          service: 'S3'
        },
        policy: AwsCustomResourcePolicy.fromStatements([
          new PolicyStatement({
            actions: ['s3:PutObject'],
            resources: [this.webAppBucket.arnForObjects('config.json')]
          })
        ])
      });
    }
  }
}
