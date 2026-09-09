/** Isolated Fargate + RDS + Redis + dual ALB. HTTPS/ACM is an operator follow-up; outputs are real ALB DNS. */

export function stackNameForTenant(tenantId: string): string {
  const slug = `vl-${tenantId}`.replace(/[^a-zA-Z0-9-]/g, "-").replace(/^-+/, "").slice(0, 40);
  return slug.replace(/^-/, "v") || "vlstack";
}

export function awsInstanceClass(size: string): { cpu: string; memory: string; db: string } {
  if (size === "fargate_medium") return { cpu: "1024", memory: "2048", db: "db.t3.small" };
  return { cpu: "512", memory: "1024", db: "db.t3.micro" };
}

function envPair(name: string, value: unknown): { Name: string; Value: unknown } {
  return { Name: name, Value: value };
}

function taskContainer(name: string, imageParam: string, port: number): Record<string, unknown> {
  return {
    Name: name,
    Image: { Ref: imageParam },
    PortMappings: [{ ContainerPort: port }],
    Environment: [
      envPair("PORT", String(port)),
      envPair("DEPLOYMENT_PROFILE", "cloud-api"),
      envPair("NODE_ENV", "production"),
      envPair("CLOUD_BIND_EXACT_PORT", "1"),
      envPair("HEALTH_VOICE_DEPENDENCIES", "configured"),
      envPair("ADMIN_AUTH_MODE", "hybrid"),
      envPair("ALLOW_ADMIN_API_KEY_IN_PROD", "true"),
      envPair("JWT_SECRET", { Ref: "JwtSecret" }),
      envPair("ADMIN_API_KEY", { Ref: "AdminApiKey" }),
      envPair("SECRET_ENCRYPTION_KEY", { Ref: "SecretEncryptionKey" }),
      envPair("MEDIA_STREAM_TOKEN", { Ref: "MediaStreamToken" }),
      envPair("PUBLIC_BASE_URL", { Ref: "PublicBaseUrl" }),
      envPair("CONTROL_URL", { Ref: "PublicBaseUrl" }),
      envPair("CONTROL_PLANE_URL", { Ref: "PublicBaseUrl" }),
      envPair("CONTROL_PLANE_API_KEY", { Ref: "AdminApiKey" }),
      envPair("AUDIO_PUBLIC_BASE_URL", { "Fn::Sub": "${PublicBaseUrl}/audio" }),
      envPair("VERALUX_WEBHOOK_URL", { "Fn::Sub": "${RuntimePublicUrl}/v1/telnyx/webhook" }),
      envPair("OPENAI_API_KEY", { Ref: "OpenAiKey" }),
      envPair("DEEPGRAM_API_KEY", { Ref: "DeepgramKey" }),
      envPair("ELEVENLABS_API_KEY", { Ref: "ElevenKey" }),
      envPair("TELNYX_API_KEY", { Ref: "TelnyxKey" }),
      envPair("TELNYX_CONNECTION_ID", { Ref: "TelnyxConnectionId" }),
      envPair("DATABASE_URL", { "Fn::Sub": "postgresql://veralux:${DbPassword}@${Database.Endpoint.Address}:5432/veralux" }),
      envPair("REDIS_URL", { "Fn::Sub": "redis://${Redis.RedisEndpoint.Address}:6379" }),
    ],
  };
}

export function buildAwsStackTemplate(): Record<string, unknown> {
  return {
    AWSTemplateFormatVersion: "2010-09-09",
    Description: "VeraLux isolated cloud-api stack (Fargate + RDS + Redis)",
    Parameters: {
      TenantId: { Type: "String" },
      ControlImage: { Type: "String" },
      RuntimeImage: { Type: "String" },
      Cpu: { Type: "String", Default: "512" },
      Memory: { Type: "String", Default: "1024" },
      DbClass: { Type: "String", Default: "db.t3.micro" },
      DbPassword: { Type: "String", NoEcho: true },
      JwtSecret: { Type: "String", NoEcho: true, Default: "pending-jwt" },
      AdminApiKey: { Type: "String", NoEcho: true, Default: "pending-admin" },
      SecretEncryptionKey: { Type: "String", NoEcho: true, Default: "pending-sek" },
      MediaStreamToken: { Type: "String", NoEcho: true, Default: "pending-mst" },
      PublicBaseUrl: { Type: "String", Default: "http://pending.local" },
      RuntimePublicUrl: { Type: "String", Default: "http://pending.local" },
      OpenAiKey: { Type: "String", NoEcho: true, Default: "none" },
      DeepgramKey: { Type: "String", NoEcho: true, Default: "none" },
      ElevenKey: { Type: "String", NoEcho: true, Default: "none" },
      TelnyxKey: { Type: "String", NoEcho: true, Default: "none" },
      TelnyxConnectionId: { Type: "String", Default: "none" },
    },
    Resources: {
      Vpc: {
        Type: "AWS::EC2::VPC",
        Properties: { CidrBlock: "10.40.0.0/16", EnableDnsSupport: true, EnableDnsHostnames: true },
      },
      Igw: { Type: "AWS::EC2::InternetGateway" },
      IgwAttach: {
        Type: "AWS::EC2::VPCGatewayAttachment",
        Properties: { VpcId: { Ref: "Vpc" }, InternetGatewayId: { Ref: "Igw" } },
      },
      PublicA: {
        Type: "AWS::EC2::Subnet",
        Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.40.1.0/24", MapPublicIpOnLaunch: true, AvailabilityZone: { "Fn::Select": [0, { "Fn::GetAZs": "" }] } },
      },
      PublicB: {
        Type: "AWS::EC2::Subnet",
        Properties: { VpcId: { Ref: "Vpc" }, CidrBlock: "10.40.2.0/24", MapPublicIpOnLaunch: true, AvailabilityZone: { "Fn::Select": [1, { "Fn::GetAZs": "" }] } },
      },
      PublicRt: {
        Type: "AWS::EC2::RouteTable",
        Properties: { VpcId: { Ref: "Vpc" } },
      },
      DefaultRoute: {
        Type: "AWS::EC2::Route",
        DependsOn: "IgwAttach",
        Properties: { RouteTableId: { Ref: "PublicRt" }, DestinationCidrBlock: "0.0.0.0/0", GatewayId: { Ref: "Igw" } },
      },
      AssocA: { Type: "AWS::EC2::SubnetRouteTableAssociation", Properties: { SubnetId: { Ref: "PublicA" }, RouteTableId: { Ref: "PublicRt" } } },
      AssocB: { Type: "AWS::EC2::SubnetRouteTableAssociation", Properties: { SubnetId: { Ref: "PublicB" }, RouteTableId: { Ref: "PublicRt" } } },
      AlbSg: {
        Type: "AWS::EC2::SecurityGroup",
        Properties: {
          GroupDescription: "veralux alb",
          VpcId: { Ref: "Vpc" },
          SecurityGroupIngress: [{ IpProtocol: "tcp", FromPort: 80, ToPort: 80, CidrIp: "0.0.0.0/0" }],
        },
      },
      AppSg: {
        Type: "AWS::EC2::SecurityGroup",
        Properties: {
          GroupDescription: "veralux app",
          VpcId: { Ref: "Vpc" },
          SecurityGroupIngress: [
            { IpProtocol: "tcp", FromPort: 4000, ToPort: 4001, SourceSecurityGroupId: { Ref: "AlbSg" } },
          ],
        },
      },
      DataSg: {
        Type: "AWS::EC2::SecurityGroup",
        Properties: {
          GroupDescription: "veralux data",
          VpcId: { Ref: "Vpc" },
          SecurityGroupIngress: [
            { IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, SourceSecurityGroupId: { Ref: "AppSg" } },
            { IpProtocol: "tcp", FromPort: 6379, ToPort: 6379, SourceSecurityGroupId: { Ref: "AppSg" } },
          ],
        },
      },
      DbSubnet: {
        Type: "AWS::RDS::DBSubnetGroup",
        Properties: { DBSubnetGroupDescription: "veralux", SubnetIds: [{ Ref: "PublicA" }, { Ref: "PublicB" }] },
      },
      Database: {
        Type: "AWS::RDS::DBInstance",
        Properties: {
          Engine: "postgres",
          DBInstanceClass: { Ref: "DbClass" },
          AllocatedStorage: "20",
          MasterUsername: "veralux",
          MasterUserPassword: { Ref: "DbPassword" },
          DBName: "veralux",
          VPCSecurityGroups: [{ Ref: "DataSg" }],
          DBSubnetGroupName: { Ref: "DbSubnet" },
          PubliclyAccessible: false,
          DeletionProtection: false,
          BackupRetentionPeriod: 1,
        },
      },
      RedisSubnet: {
        Type: "AWS::ElastiCache::SubnetGroup",
        Properties: { Description: "veralux redis", SubnetIds: [{ Ref: "PublicA" }, { Ref: "PublicB" }] },
      },
      Redis: {
        Type: "AWS::ElastiCache::CacheCluster",
        Properties: {
          Engine: "redis",
          CacheNodeType: "cache.t3.micro",
          NumCacheNodes: 1,
          VpcSecurityGroupIds: [{ Ref: "DataSg" }],
          CacheSubnetGroupName: { Ref: "RedisSubnet" },
        },
      },
      Cluster: { Type: "AWS::ECS::Cluster" },
      ExecRole: {
        Type: "AWS::IAM::Role",
        Properties: {
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [{ Effect: "Allow", Principal: { Service: "ecs-tasks.amazonaws.com" }, Action: "sts:AssumeRole" }],
          },
          ManagedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"],
        },
      },
      ControlAlb: {
        Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
        Properties: { Scheme: "internet-facing", Subnets: [{ Ref: "PublicA" }, { Ref: "PublicB" }], SecurityGroups: [{ Ref: "AlbSg" }] },
      },
      RuntimeAlb: {
        Type: "AWS::ElasticLoadBalancingV2::LoadBalancer",
        Properties: { Scheme: "internet-facing", Subnets: [{ Ref: "PublicA" }, { Ref: "PublicB" }], SecurityGroups: [{ Ref: "AlbSg" }] },
      },
      ControlTg: {
        Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
        Properties: {
          Port: 4000,
          Protocol: "HTTP",
          TargetType: "ip",
          VpcId: { Ref: "Vpc" },
          HealthCheckPath: "/health",
        },
      },
      RuntimeTg: {
        Type: "AWS::ElasticLoadBalancingV2::TargetGroup",
        Properties: {
          Port: 4001,
          Protocol: "HTTP",
          TargetType: "ip",
          VpcId: { Ref: "Vpc" },
          HealthCheckPath: "/health/live",
        },
      },
      ControlListener: {
        Type: "AWS::ElasticLoadBalancingV2::Listener",
        Properties: {
          LoadBalancerArn: { Ref: "ControlAlb" },
          Port: 80,
          Protocol: "HTTP",
          DefaultActions: [{ Type: "forward", TargetGroupArn: { Ref: "ControlTg" } }],
        },
      },
      RuntimeListener: {
        Type: "AWS::ElasticLoadBalancingV2::Listener",
        Properties: {
          LoadBalancerArn: { Ref: "RuntimeAlb" },
          Port: 80,
          Protocol: "HTTP",
          DefaultActions: [{ Type: "forward", TargetGroupArn: { Ref: "RuntimeTg" } }],
        },
      },
      ControlTask: {
        Type: "AWS::ECS::TaskDefinition",
        Properties: {
          Cpu: { Ref: "Cpu" },
          Memory: { Ref: "Memory" },
          NetworkMode: "awsvpc",
          RequiresCompatibilities: ["FARGATE"],
          ExecutionRoleArn: { "Fn::GetAtt": ["ExecRole", "Arn"] },
          ContainerDefinitions: [taskContainer("control", "ControlImage", 4000)],
        },
      },
      RuntimeTask: {
        Type: "AWS::ECS::TaskDefinition",
        Properties: {
          Cpu: { Ref: "Cpu" },
          Memory: { Ref: "Memory" },
          NetworkMode: "awsvpc",
          RequiresCompatibilities: ["FARGATE"],
          ExecutionRoleArn: { "Fn::GetAtt": ["ExecRole", "Arn"] },
          ContainerDefinitions: [taskContainer("runtime", "RuntimeImage", 4001)],
        },
      },
      ControlService: {
        Type: "AWS::ECS::Service",
        DependsOn: "ControlListener",
        Properties: {
          Cluster: { Ref: "Cluster" },
          LaunchType: "FARGATE",
          DesiredCount: 1,
          TaskDefinition: { Ref: "ControlTask" },
          NetworkConfiguration: {
            AwsvpcConfiguration: {
              AssignPublicIp: "ENABLED",
              Subnets: [{ Ref: "PublicA" }, { Ref: "PublicB" }],
              SecurityGroups: [{ Ref: "AppSg" }],
            },
          },
          LoadBalancers: [{ ContainerName: "control", ContainerPort: 4000, TargetGroupArn: { Ref: "ControlTg" } }],
        },
      },
      RuntimeService: {
        Type: "AWS::ECS::Service",
        DependsOn: "RuntimeListener",
        Properties: {
          Cluster: { Ref: "Cluster" },
          LaunchType: "FARGATE",
          DesiredCount: 1,
          TaskDefinition: { Ref: "RuntimeTask" },
          NetworkConfiguration: {
            AwsvpcConfiguration: {
              AssignPublicIp: "ENABLED",
              Subnets: [{ Ref: "PublicA" }, { Ref: "PublicB" }],
              SecurityGroups: [{ Ref: "AppSg" }],
            },
          },
          LoadBalancers: [{ ContainerName: "runtime", ContainerPort: 4001, TargetGroupArn: { Ref: "RuntimeTg" } }],
        },
      },
    },
    Outputs: {
      ControlUrl: { Value: { "Fn::Sub": "http://${ControlAlb.DNSName}" } },
      RuntimeUrl: { Value: { "Fn::Sub": "http://${RuntimeAlb.DNSName}" } },
      DatabaseUrl: {
        Value: { "Fn::Sub": "postgresql://veralux:${DbPassword}@${Database.Endpoint.Address}:5432/veralux" },
      },
      RedisUrl: {
        Value: { "Fn::Sub": "redis://${Redis.RedisEndpoint.Address}:6379" },
      },
    },
  };
}
