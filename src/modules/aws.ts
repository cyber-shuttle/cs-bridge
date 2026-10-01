import * as vscode from 'vscode';
import {
    EC2Client,
    CreateKeyPairCommand,
    DeleteKeyPairCommand,
    EC2ServiceException,
    paginateDescribeInstances,
    AuthorizeSecurityGroupIngressCommand,
    CreateSecurityGroupCommand,
    DescribeSecurityGroupsCommand,
    RunInstancesCommand,
    StopInstancesCommand,
    StartInstancesCommand,
    TerminateInstancesCommand,
    DescribeRegionsCommand,
    paginateDescribeInstanceTypes,
    _InstanceType,
    Instance,
} from "@aws-sdk/client-ec2";

import { CloudFormOptions, CloudInstanceInfo, InstanceActions, SshHost } from "../models";
import { addSshConfigEntryAWS, deleteSshConfigEntry, SshManager } from '../modules/sshSupport';
import { writeFileSync, unlinkSync, existsSync } from "fs";
import path from "path";
import { confirmModal } from '@/webviewProvider';
import { Logger } from '@/logger';
import { getActiveRegions, updateRegion } from './cloudStore';
import { GetParameterCommand, ParameterNotFound, SSMClient, SSMServiceException } from '@aws-sdk/client-ssm';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const DEFAULT_REGION = 'us-east-1'
const UBUNTU_IMAGE_PATH = "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id"
const AMA_IMAGE_PATH = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
export default class AWSClient {

    protected readonly logger = Logger.getInstance();
    protected readonly KEY_NAME = "cs-aws-generated-key";
    private defaultClient: EC2Client | null = null;
    private readonly securityGroupName = "CS-Brige VSCode Ext SSH Access"
    protected pollInternval: NodeJS.Timeout | null = null;
    protected instances: CloudInstanceInfo[] = [];
    protected hosts: SshHost[] = [];
    protected regions: string[] = [];
    protected types: string[] = [];
    protected images: string[][] = [[AMA_IMAGE_PATH, "Amazon Linux"], [UBUNTU_IMAGE_PATH, "Ubuntu 24.04 LTS"]];
    private secretKey: string = ""
    private accessKey: string = ""
    private sessionToken: string = ""
    protected activeRegions: string[] = []

    private clients: Record<string, EC2Client> = {};

    protected readonly SSH_CONFIG_PATH = SshManager.getInstance().getSSHConfigPath()

    protected readonly PRIVATE_KEY_PATH = path.join(
        SshManager.getInstance().getSSHKeyPath(),
        this.KEY_NAME,
    );
    private toast(title: string, message: string, cancellable: boolean) {
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title,
            cancellable
        }, async (progress) => {
            progress.report({ message });
            await new Promise(resolve => setTimeout(resolve, 5000));

        });
    }

    constructor() {
        this.activeRegions = getActiveRegions()
        this.logger.info(`Current Active Regions: ${this.activeRegions}`)

    }

    public isReady(): boolean {
        return this.defaultClient !== null
    }

    private getRegionKeyName(region: string): string {
        return `${this.KEY_NAME}-${region}`
    }

    private getRegionKeyPath(region: string): string {
        return `${this.PRIVATE_KEY_PATH}-${region}`
    }

    public async initEC2Client(region: string): Promise<void> {

        const accessKey = (
            await vscode.window.showInputBox({
                title: "Enter AWS Access Key",
                placeHolder: "AWS Acxess Key",
                ignoreFocusOut: true,
            })
        )?.trim();
        if (!accessKey) {
            return;
        }

        const secretKey = (
            await vscode.window.showInputBox({
                title: "Enter AWS Secret Key",
                placeHolder: "AWS Secret Key",
                ignoreFocusOut: true,
            })
        )?.trim();
        if (!secretKey) {
            return;
        }
        const sessionToken = (
            await vscode.window.showInputBox({
                title: "Enter AWS Session Token",
                placeHolder: "AWS Session Token",
                ignoreFocusOut: true,
            })
        )?.trim();
        if (!sessionToken) {
            return;
        }

        this.secretKey = secretKey
        this.accessKey = accessKey
        this.sessionToken = sessionToken

        if (this.activeRegions.length > 0) {

            this.activeRegions.forEach(region => {
                if (!(region in this.clients)) {

                    this.logger.info(`EC2 Client for ${region}  initialized`)
                    const client = new EC2Client({
                        region: region,
                        credentials: {
                            accessKeyId: accessKey,
                            secretAccessKey: secretKey,
                            sessionToken: sessionToken,
                        },
                    });
                    if (this.defaultClient === null) {
                        this.defaultClient = client
                    }
                    this.clients[region] = client
                }

            });
        } else {

            const client = new EC2Client({
                region: region,
                credentials: {
                    accessKeyId: accessKey,
                    secretAccessKey: secretKey,
                    sessionToken: sessionToken,
                },
            });
            if (this.defaultClient === null) {
                this.defaultClient = client
            }
            this.clients[region] = client

        }



        this.logger.info("EC2 Client(s) initialized")
        this.logger.info(`SSH Config Path: ${this.SSH_CONFIG_PATH}`)
        this.logger.info(`SSH Key Path: ${this.PRIVATE_KEY_PATH}`)
    }

    protected getClientForRegion(region: string): EC2Client {
        if (region in this.clients) {
            return this.clients[region]
        } else {
            const regionClient = new EC2Client({
                region: region,
                credentials: {
                    accessKeyId: this.accessKey,
                    secretAccessKey: this.secretKey,
                    sessionToken: this.sessionToken,
                },
            });
            this.clients[region] = regionClient
            return regionClient
        }
    }

    // Entire workflow for launching EC2 instance
    public async launchEC2Instance(image: string, type: string, region: string): Promise<void> {


        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Setting up EC2 Instance...",
                cancellable: true,
            },
            // Outline for what is needed to launch instance
            async (progress) => {
                try {
                    progress.report({ message: "Generating SSH Key Pair..." });
                    await this.generateSSHKeyPair(region)
                    await sleep(2500)
                    progress.report({ message: "Check Security Groups" });
                    const securityGroupID = await this.getSSHSecurityGroup(region)
                    await sleep(2500)
                    if (securityGroupID === "") {

                        progress.report({ message: "Did not find existing security group for CS-Bridge" });
                        await sleep(2500)
                        progress.report({ message: "Creating new Security Group" });
                        await this.creatSSHSecurityGroup(region)
                        await sleep(2500)
                    } else {
                        progress.report({ message: "Found existing CS-Bridge Security Group" });
                        await sleep(2500)
                    }
                    progress.report({ message: "Creating Instance..." });
                    this.logger.info("Creating Innstance")
                    this.createInstance(image, type, this.getRegionKeyName(region), securityGroupID, region);
                    sleep(3000);
                    progress.report({ message: "Instance is running." });
                } catch (error: any) {
                    vscode.window.showErrorMessage("Failed to launch instance");
                }
            },
        );
    }

    // Create EC2 Instance
    // add options for image, and instance type later
    protected async createInstance(imagePath: string, instanceType: string, keyName: string, securityGroupID: string, region: string): Promise<void> {
        const client = this.getClientForRegion(region)
        const instanceID = crypto.randomUUID().slice(0, 5)
        try {

            const imageID = await this.getLatestImage(region, imagePath)

            if (imageID !== undefined) {
                await client.send(new RunInstancesCommand({
                    ImageId: imageID,
                    InstanceType: instanceType as _InstanceType,
                    KeyName: keyName,
                    SecurityGroupIds: [securityGroupID],
                    MinCount: 1,
                    MaxCount: 1,
                    TagSpecifications: [
                        {
                            ResourceType: "instance",
                            Tags: [
                                { Key: "Name", Value: `CS-Bridge-Instance-${instanceID}` },
                                { Key: "Environment", Value: "CS-Bridge" }
                            ]
                        }
                    ]
                }));
            } else {
                this.logger.error("Failed to get Image ID. Response was undefined")
            }

        } catch (errors) {
            this.logger.info("Failed to create instance: ", errors)
        }

    }

    private async generateSSHKeyPair(region: string): Promise<void> {
        const keyName = this.getRegionKeyName(region)
        const keyPath = this.getRegionKeyPath(region) // fullpath with filename
        const client = this.getClientForRegion(region)
        try {
            if (!existsSync(keyPath)) {
                this.logger.info(`Creating key pair: ${keyName}...`);
                const keyPairResponse = await client.send(
                    new CreateKeyPairCommand({
                        KeyName: keyName,
                        KeyType: "ed25519",
                    }),
                );

                const privateKey = keyPairResponse?.KeyMaterial;
                if (privateKey !== undefined) {
                    writeFileSync(keyPath, privateKey, { mode: 0o600 });
                    this.logger.info(`Private key safely written to ${keyPath}`);
                } else {
                    this.logger.info("Error: Response from key pair generation is undefined");
                }
            } else {
                this.logger.info(
                    "Dectecting Keys Exists. ...Skipping Key Pair generation. ",
                );
            }
        } catch (error) {
            if (error instanceof Error) {
                this.logger.error(`Error (${error.name}):`, error.message,);
            } else {
                this.logger.error("An unknown error occurred:", error);
            }
        }
    }

    public async remmoveKeyPair(keyName: string, region: string): Promise<void> {
        const client = this.getClientForRegion(region)
        try {
            this.logger.info("Removing Key Pair from AWS");
            const command = new DeleteKeyPairCommand({ KeyName: keyName });
            await client.send(command);
            this.logger.info("Removing local copy of key");
            unlinkSync(this.getRegionKeyPath(region));
        } catch (error) {
            if (error instanceof EC2ServiceException) {
                this.logger.error(`AWS Error [${error.name}]: ${error.message}`);
            } else {
                this.logger.error(`Unhandled Error ${error}`);
            }
        }
    }
    // Get Existing Security For CS-Brige
    public async getSSHSecurityGroup(region: string): Promise<string> {
        const client = this.getClientForRegion(region)
        const params = {
            Filters: [
                {
                    Name: "group-name",
                    Values: [this.securityGroupName]
                }
            ]
        };

        try {
            const command = new DescribeSecurityGroupsCommand(params);
            const data = await client.send(command);

            const securityGroups = data.SecurityGroups;
            if (this.securityGroupName.length === 0) {
                this.logger.info("Did not find exisitng group")
                return ""
            } else {
                this.logger.info("Found Exisitng Sec Group")
                return securityGroups?.at(0)?.GroupName ?? ""
            }

        } catch (error) {
            this.logger.error("Failed to get Security Groups:", error);
        }
        return ""

    }
    // Create Security For SSH Access
    public async creatSSHSecurityGroup(region: string): Promise<string> {
        const client = this.getClientForRegion(region)

        try {
            const createCommand = new CreateSecurityGroupCommand({
                GroupName: this.securityGroupName,
                Description: "Security group - CS-Bridge SSH access",
            });

            const createResponse = await client.send(createCommand);
            const groupID = createResponse.GroupId;
            this.logger.info(`Created Security Group with ID: ${groupID}`);

            const sshGroupCommand = new AuthorizeSecurityGroupIngressCommand({
                GroupId: groupID,
                IpPermissions: [
                    {
                        IpProtocol: "tcp",
                        FromPort: 22,
                        ToPort: 22,
                        IpRanges: [
                            {
                                CidrIp: "0.0.0.0/0",
                                Description: " SSH Access"
                            }
                        ]
                    }
                ]
            });

            await client.send(sshGroupCommand);
            this.logger.info("Inbound SSH rule attached to the new group.");
            return groupID ?? ""


        } catch (error) {
            this.logger.error("Creating SSH Sec Group failed:", error);
            return ""
        }
    }

    public async doInstanceActions(action: InstanceActions, instanceID: string, instanceName: string, region: string): Promise<void> {
        const client = this.getClientForRegion(region)

        let command = null;
        let msg = "no action"
        let title = "no action"
        switch (action) {
            case InstanceActions.Stop:
                command = new StopInstancesCommand({
                    InstanceIds: [instanceID],
                });
                break
            case InstanceActions.Start:
                command = new StartInstancesCommand({
                    InstanceIds: [instanceID],
                });
                break
            case InstanceActions.Remove:
                command = new TerminateInstancesCommand({
                    InstanceIds: [instanceID],
                });
        }

        try {
            await client.send(command);

            switch (action) {
                case InstanceActions.Stop:
                    msg = `Stopping instance: ${instanceID}`
                    title = "Stop Instance"
                    break
                case InstanceActions.Start:
                    msg = `Restarting instance: ${instanceID}`
                    title = "Restart Instance"
                    break
                case InstanceActions.Remove:
                    msg = `Removing instance: ${instanceID}`
                    title = "Remove Instance"
                    break
            }
            this.logger.info(msg);
            this.toast(title, msg, false)

            if (action === InstanceActions.Remove) {
                await this.removeSshConfigEntryAWS(instanceID, instanceName)
            }

        } catch (error) {
            const errMsg = `Error ${title}: ${error}`
            this.logger.error(errMsg);
            vscode.window.showErrorMessage(errMsg)
        }
    }

    public async removeInstance(instanceID: string, instanceName: string, region: string): Promise<void> {
        this.logger.info("Start Removing Instance")
        const confirmed = await confirmModal('Remove Instnace?', 'Remove',
            'This stops and terminates the instance')
        if (!confirmed) {
            this.logger.info("Cancel remove")
            return;
        }
        await this.doInstanceActions(InstanceActions.Remove, instanceID, instanceName, region)
    }

    public getInstances(): CloudInstanceInfo[] {
        return this.instances
    }

    protected async fetchInstanceForRegion(client: EC2Client, region: string): Promise<Instance[]> {
        this.logger.info(`Polling instances for ${region}`)
        const config = {
            client: client,
            pageSize: 100,
        };
        const params = {
            Filters: [
                {
                    Name: "tag:Environment",
                    Values: ["CS-Bridge"]
                },
                {
                    Name: "instance-state-name",
                    Values: ["pending", "running", "shutting-down", "stopping", "stopped"]
                }
            ]
        }

        const instances: Instance[] = [];
        try {
            const paginator = paginateDescribeInstances(config, params);

            for await (const page of paginator) {
                for (const reservation of page.Reservations ?? []) {
                    instances.push(...(reservation.Instances ?? []));
                }
            }
        } catch (error) {
            this.logger.error(`Get instances for failed:`, error);
        }

        return instances
    }


    public async pollInstances(): Promise<void> {
        const cloudInstances: CloudInstanceInfo[] = [];
        const activeRegions = new Set<string>()

        this.logger.info("Fetching instances ....")

        const results = await Promise.allSettled(
            Object.entries(this.clients).map(async ([region, client]) => ({
                region,
                instances: await this.fetchInstanceForRegion(client, region),
            }))
        );

        for (const result of results) {
            if (result.status === "rejected") {
                this.logger.error(`Polling for failed:${result.reason}`);
                continue;
            }
            const { region, instances } = result.value;
            for (const instance of instances) {
                const inst: CloudInstanceInfo = {
                    instanceID: instance.InstanceId ?? "",
                    instanceType: instance.InstanceType ?? "",
                    name: instance.Tags?.find(value => value.Key == "Name")?.Value ?? "",
                    state: instance.State?.Name ?? "",
                    publicIp: instance.PublicIpAddress ?? "",
                    vendor: "aws",
                    region: region
                }

                activeRegions.add(region)
                cloudInstances.push(inst)
            }
        }
        this.instances = cloudInstances
        this.activeRegions = Array.from(activeRegions)
        updateRegion(this.activeRegions)
        this.logger.info("Done Polling instances")
    }

    public openTerminal(ip: string, region: string): void {
        const hostString = `ec2-user@${ip}`
        vscode.window.createTerminal({ name: ip, shellPath: 'ssh', shellArgs: [...SshManager.getInstance().buildControlMasterArgs(ip), "-i", this.getRegionKeyPath(region), hostString] }).show();

    }

    public async openRemoteSession(id: string, name: string, ip: string, region: string): Promise<void> {
        this.hosts = SshManager.getInstance().getCSHosts()
        this.logger.info("Checking SSH Config")
        if (this.hosts.find(host => host.hostname === ip)) {
            this.logger.info("Found existing entry")
        } else {
            await addSshConfigEntryAWS(id, name, ip, 22, this.getRegionKeyPath(region))
            this.hosts = SshManager.getInstance().getCSHosts()
        }

        const sshConfig = vscode.workspace.getConfiguration('remote.SSH');
        await sshConfig.update('configFile', this.SSH_CONFIG_PATH, vscode.ConfigurationTarget.Global);

        const uri = vscode.Uri.from({
            scheme: 'vscode-remote',
            authority: `ssh-remote+${name}`,
            path: '/'
        });


        this.logger.info("Openning Remote Session")
        await vscode.commands.executeCommand('vscode.openFolder', uri, {
            forceNewWindow: true
        });

    }

    protected async removeSshConfigEntryAWS(id: string, name: string): Promise<void> {
        this.logger.info(`Remove SSH Config for ${name} `)
        await deleteSshConfigEntry(id, name, false)

    }

    public async getEnabledRegions(): Promise<void> {
        if (this.defaultClient === null) {
            throw new Error("EC2 Client is not initialized")
        }
        try {
            const command = new DescribeRegionsCommand({
                AllRegions: false
            });

            const response = await this.defaultClient.send(command);
            response.Regions?.map(region => {
                if (region.RegionName) {
                    this.regions.push(region.RegionName)
                }
            });


        } catch (error) {
            this.logger.error("Error fetching regions:", error);
        }
    }

    public async getInstanceTypes() {
        if (this.defaultClient === null) {
            throw new Error("EC2 Client is not initialized")
        }
        const paginator = paginateDescribeInstanceTypes(
            { client: this.defaultClient, pageSize: 100 },
            {
                Filters: [
                    {
                        Name: "instance-type",
                        Values: ["m*", "t*"]
                    }
                ]
            }
        );

        try {
            for await (const page of paginator) {
                if (page.InstanceTypes) {
                    page.InstanceTypes.forEach(type => {
                        if (type.InstanceType) {
                            this.types.push(type.InstanceType)
                        }
                    });
                }
            }
            this.types.sort()

        } catch (error) {
            this.logger.error("Error executing filtered instance scan:", error);
        }
    }

    public async getOptions(): Promise<CloudFormOptions> {
        this.logger.info("Fetching Options for AWS")
        await Promise.allSettled([this.getEnabledRegions(), this.getInstanceTypes()])
        this.logger.info("Done Fetching Options for AWS")
        return {
            image: this.images,
            type: this.types.map(type => [type, type]),
            region: this.regions.map(region => [region, region])
        }
    }

    private async getLatestImage(region: string, imagePath: string): Promise<string | undefined> {
        const ssm = new SSMClient({
            region: region,
            credentials: {
                accessKeyId: this.accessKey,
                secretAccessKey: this.secretKey,
                sessionToken: this.sessionToken,
            },
        })
        try {
            const command = new GetParameterCommand({ Name: imagePath });
            const response = await ssm.send(command);
            this.logger.info("Extracted Value:", response.Parameter?.Value);
            return response.Parameter?.Value;
        } catch (error) {
            if (error instanceof ParameterNotFound) {
                this.logger.error(`The parameter path "${imagePath}" was not found.`);
            } else if (error instanceof SSMServiceException) {
                this.logger.error(`SSM Service Error ${error.name}: ${error.message}`);
            } else {
                this.logger.error("An error occurred:", error);
            }
        }

    }

}
