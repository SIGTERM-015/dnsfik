import { Logger } from "../utils/logger";
import { CloudflareService, DNSRecord } from "./cloudflare.service";
import { IPService } from "./ip.service";
import { TaskWorker } from "../workers/task.worker";
import { TaskType, TaskStatus, DNSTask } from "../models/task.model";
import { v4 as uuidv4 } from "uuid";
import { LabelValidator, DNSLabel } from "../utils/validators";
import { DockerService } from "./docker.service";

interface DNSUpdateOptions {
  serviceName: string;
  recordType?: string;
  name: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
}

export class DNSService {
  private static instance: DNSService;
  private logger = Logger.getInstance();
  private cloudflare = CloudflareService.getInstance();
  private ipService = IPService.getInstance();
  private taskWorker = TaskWorker.getInstance();
  private docker = DockerService.getInstance();
  private validator = new LabelValidator();
  private lastKnownIPv4: string | null = null;
  private lastKnownIPv6: string | null = null;

  private constructor() {}

  public static getInstance(): DNSService {
    if (!DNSService.instance) {
      DNSService.instance = new DNSService();
    }
    return DNSService.instance;
  }

  public async handleServiceUpdate(
    serviceName: string,
    labels: { [key: string]: string }
  ): Promise<void> {
    this.logger.debug("Handling container update", { serviceName, labels });

    // Récupérer le conteneur complet pour avoir tous les labels
    const container = await this.docker.getContainer(serviceName);
    const containerInfo = await container.inspect();
    const allLabels = containerInfo.Config?.Labels || {};

    // Utiliser tous les labels pour la validation
    const dnsLabels = this.validator.validateServiceLabels(
      serviceName,
      allLabels
    );

    for (const label of dnsLabels) {
      const dnsOptions = {
        serviceName,
        name: label.hostname,
        recordType: label.type,
        content: label.content,
        ttl: label.ttl,
        proxied: label.proxied,
      };

      this.logger.debug("Processing DNS options", { dnsOptions });

      // Handle content resolution
      if (!dnsOptions.content || dnsOptions.content === "public_ip") {
        const recordType = (dnsOptions.recordType || "A") as "A" | "AAAA";
        this.logger.debug(
          `Fetching public IP for record type ${recordType}`,
          { hasContent: !!dnsOptions.content }
        );
        
        try {
          dnsOptions.content = await this.ipService.getPublicIP(recordType);
        } catch (ipError) {
          if (recordType === "AAAA") {
            // IPv6 might not be available, skip this record
            this.logger.warn(
              `Failed to fetch IPv6 address, skipping AAAA record`,
              {
                hostname: label.hostname,
                error: ipError,
              }
            );
            continue; // Skip this record and continue with next
          }
          // For IPv4 (A records), rethrow the error as it's critical
          throw ipError;
        }
      }

      await this.createOrUpdateDNSRecord(dnsOptions);
    }
  }

  private async createOrUpdateDNSRecord(
    options: DNSUpdateOptions
  ): Promise<void> {
    this.logger.debug("Creating/updating DNS record", { options });

    const record: DNSRecord = {
      type: options.recordType || "A",
      name: options.name,
      content: options.content!,
      ttl: options.ttl || 1,
      proxied: typeof options.proxied === "boolean" ? options.proxied : true,
    };

    const existingRecord = await this.cloudflare.getDNSRecord(
      options.name,
      record.type
    );

    if (existingRecord) {
      const needsUpdate =
        existingRecord.content !== record.content ||
        existingRecord.ttl !== record.ttl ||
        existingRecord.proxied !== record.proxied;

      if (!needsUpdate) {
        this.logger.debug("DNS record already up to date", {
          name: record.name,
          type: record.type,
          content: record.content,
          proxied: record.proxied,
        });
        return;
      }

      this.logger.info("Updating DNS record", {
        name: record.name,
        type: record.type,
        content: record.content,
        previous: existingRecord.content,
        proxied: record.proxied,
        reason: {
          contentChanged: existingRecord.content !== record.content,
          ttlChanged: existingRecord.ttl !== record.ttl,
          proxiedChanged: existingRecord.proxied !== record.proxied,
        },
      });
    } else {
      this.logger.info("Creating DNS record", {
        name: record.name,
        type: record.type,
        content: record.content,
        proxied: record.proxied,
      });
    }

    const task: DNSTask = {
      id: uuidv4(),
      type: existingRecord ? TaskType.UPDATE : TaskType.CREATE,
      status: TaskStatus.PENDING,
      attempts: 0,
      maxAttempts: 3,
      data: {
        serviceName: options.serviceName,
        recordType: record.type,
        name: record.name,
        content: record.content,
        ttl: record.ttl,
        proxied: record.proxied,
      },
    };

    if (existingRecord) {
      task.data = { ...task.data, recordId: existingRecord.id };
    }

    this.logger.debug("Adding task to queue", { taskId: task.id, task });
    await this.taskWorker.addTask(task);
  }

  public async checkAndUpdateIPAddresses(): Promise<void> {
    try {
      // Check IPv4
      const currentIPv4 = await this.ipService.getPublicIPv4();
      if (this.lastKnownIPv4 && this.lastKnownIPv4 !== currentIPv4) {
        this.logger.info("IPv4 address changed", {
          old: this.lastKnownIPv4,
          new: currentIPv4,
        });
        await this.updateAllRecordsWithIP("A", currentIPv4);
      }
      this.lastKnownIPv4 = currentIPv4;

      // Check IPv6 (try but don't fail if not available)
      try {
        const currentIPv6 = await this.ipService.getPublicIPv6();
        if (this.lastKnownIPv6 && this.lastKnownIPv6 !== currentIPv6) {
          this.logger.info("IPv6 address changed", {
            old: this.lastKnownIPv6,
            new: currentIPv6,
          });
          await this.updateAllRecordsWithIP("AAAA", currentIPv6);
        }
        this.lastKnownIPv6 = currentIPv6;
      } catch (ipv6Error) {
        this.logger.debug("IPv6 not available or failed to fetch", {
          error: ipv6Error,
        });
      }
    } catch (error) {
      this.logger.error("Failed to check IP addresses", { error });
      throw error;
    }
  }

  private async updateAllRecordsWithIP(
    recordType: "A" | "AAAA",
    newIP: string
  ): Promise<void> {
    try {
      // Get all running containers
      const docker = this.docker;
      const containers = await docker["docker"].listContainers();

      this.logger.info(
        `Updating ${recordType} records with new IP for ${containers.length} containers`,
        { newIP }
      );

      for (const container of containers) {
        try {
          const containerInfo = await docker
            .getContainer(container.Id)
            .inspect();
          const labels = containerInfo.Config?.Labels || {};
          const dnsLabels = this.validator.validateServiceLabels(
            container.Names[0].replace(/^\//, ""),
            labels
          );

          // Update records that match the type and use public IP (no content or content="public_ip")
          for (const label of dnsLabels) {
            const shouldUpdate =
              label.type === recordType &&
              (!label.content || label.content === "public_ip");

            if (shouldUpdate) {
              const serviceName = container.Names[0].replace(/^\//, "");
              this.logger.info(`Updating ${recordType} record for ${serviceName}`, {
                hostname: label.hostname,
                newIP,
              });

              await this.createOrUpdateDNSRecord({
                serviceName,
                name: label.hostname,
                recordType: label.type,
                content: newIP,
                ttl: label.ttl,
                proxied: label.proxied,
              });
            }
          }
        } catch (containerError) {
          this.logger.error("Failed to update container DNS records", {
            error: containerError,
            container: container.Names[0],
          });
        }
      }
    } catch (error) {
      this.logger.error(`Failed to update ${recordType} records`, { error });
      throw error;
    }
  }
}
