import Docker from "dockerode";
import { EventEmitter } from "events";
import { Logger } from "../utils/logger";
import { config } from "../config/config";

export class DockerService extends EventEmitter {
  private docker: Docker;
  private logger = Logger.getInstance();
  private static instance: DockerService;

  private constructor() {
    super();
    this.docker = new Docker({ socketPath: config.docker.socketPath });
  }

  public static getInstance(): DockerService {
    if (!DockerService.instance) {
      DockerService.instance = new DockerService();
    }
    return DockerService.instance;
  }

  public async startMonitoring(): Promise<void> {
    try {
      // Scan existing containers at startup
      await this.scanExistingContainers();

      // Listen to container events
      const eventStream = await this.docker.getEvents({
        filters: {
          type: ["container"],
          event: ["create", "start", "stop", "destroy", "die", "kill"],
        },
      });

      eventStream.on("data", (buffer) => {
        const event = JSON.parse(buffer.toString());
        this.handleContainerEvent(event);
      });

      this.logger.info("Docker event monitoring started");
    } catch (error) {
      this.logger.error("Failed to start Docker event monitoring", { error });
      throw error;
    }
  }

  private async scanExistingContainers(): Promise<void> {
    try {
      // Scan all running containers
      const containers = await this.docker.listContainers();
      this.logger.debug(`Found ${containers.length} containers`, {
        containerNames: containers.map((c) => c.Names[0]),
      });

      let containerCount = 0;

      for (const container of containers) {
        this.logger.debug(`Checking container ${container.Names[0]}`, {
          image: container.Image,
          state: container.State,
          status: container.Status,
        });

        const labels = container.Labels || {};
        const dnsLabels = this.extractDNSLabels(labels);

        if (dnsLabels) {
          containerCount++;
          this.logger.debug(
            `DNS labels found on container ${container.Names[0]}`,
            { dnsLabels }
          );

          this.emit("dns-update", {
            event: "start",
            service: container.Names[0].replace(/^\//, ""),
            labels: dnsLabels,
          });
        }
      }

      this.logger.info(`Scanned ${containerCount} containers with DNS labels`);
    } catch (error) {
      this.logger.error("Failed to scan containers", { error });
      throw error;
    }
  }

  private async handleContainerEvent(event: any): Promise<void> {
    try {
      this.logger.debug("Received Docker container event", {
        type: event.Type,
        action: event.Action,
        id: event.Actor.ID,
        actor: event.Actor,
      });

      // Only handle container events
      if (event.Type !== "container") {
        return;
      }

      // For destroy events, we can't inspect the container
      if (event.Action === "destroy" || event.Action === "die" || event.Action === "kill" || event.Action === "stop") {
        const containerName = event.Actor.Attributes?.name || event.Actor.ID;
        this.logger.debug("Container stopped/destroyed", {
          containerName,
          action: event.Action,
        });
        
        // Emit removal event for DNS cleanup
        this.emit("dns-remove", {
          event: event.Action,
          service: containerName,
        });
        return;
      }

      // For other events, inspect the container to get labels
      try {
        const container = await this.docker
          .getContainer(event.Actor.ID)
          .inspect();
        const labels = container.Config?.Labels || {};
        const containerName = container.Name.replace(/^\//, "");
        
        this.logger.debug("Container event details", {
          containerName,
          labels,
          state: container.State,
          status: container.State?.Status,
        });

        const dnsLabels = this.extractDNSLabels(labels);
        if (dnsLabels) {
          this.emit("dns-update", {
            event: event.Action,
            service: containerName,
            labels: dnsLabels,
          });
        }
      } catch (error: any) {
        // Container might have been removed before we could inspect it
        if (error.statusCode === 404) {
          this.logger.debug("Container not found, likely already removed");
          return;
        }
        throw error;
      }
    } catch (error) {
      this.logger.error("Error handling container event", { error });
    }
  }

  private extractDNSLabels(labels: { [key: string]: string }): any {
    const dnsPrefix = "dns.cloudflare.";
    const dnsLabels: { [key: string]: string } = {};
    let hasDNSLabels = false;

    Object.entries(labels).forEach(([key, value]) => {
      if (key.startsWith(dnsPrefix)) {
        hasDNSLabels = true;
        dnsLabels[key] = value;
        this.logger.debug(`Found DNS label: ${key} = ${value}`);
      }
    });

    return hasDNSLabels ? dnsLabels : null;
  }

  public getContainer(containerName: string) {
    return this.docker.getContainer(containerName);
  }
}
