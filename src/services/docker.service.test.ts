import { DockerService } from "./docker.service";
import Docker from "dockerode";
import { EventEmitter } from "events";
import { Container, ContainerInfo } from "dockerode";

jest.mock("dockerode");

describe("DockerService", () => {
  let dockerService: DockerService;
  let mockDocker: jest.Mocked<Docker>;
  let mockEventStream: EventEmitter;

  beforeEach(() => {
    jest.clearAllMocks();
    (DockerService as any).instance = undefined;

    mockEventStream = new EventEmitter();
    mockDocker = {
      getEvents: jest.fn().mockResolvedValue(mockEventStream),
      listContainers: jest.fn().mockResolvedValue([]),
      getContainer: jest.fn(),
    } as any;

    (Docker as unknown as jest.Mock).mockImplementation(() => mockDocker);
    dockerService = DockerService.getInstance();
  });

  describe("startMonitoring", () => {
    it("should scan existing containers", async () => {

      const mockContainers: Partial<ContainerInfo>[] = [
        {
          Id: "container1",
          Names: ["/container1"],
          Labels: {
            "dns.cloudflare.hostname": "test1.domain.com",
          },
          Image: "nginx",
          ImageID: "image1",
          State: "running",
          Created: Date.now(),
          Command: "nginx",
          Status: "running",
        },
      ];

      mockDocker.listContainers.mockResolvedValue(
        mockContainers as ContainerInfo[]
      );

      const dnsUpdateSpy = jest.fn();
      dockerService.on("dns-update", dnsUpdateSpy);

      await dockerService.startMonitoring();

      expect(dnsUpdateSpy).toHaveBeenCalledWith({
        event: "start",
        service: "container1",
        labels: { "dns.cloudflare.hostname": "test1.domain.com" },
      });
    });

    it("should handle container start events", async () => {
      await dockerService.startMonitoring();
      mockDocker.listContainers.mockResolvedValue([]);

      const dnsUpdateSpy = jest.fn();
      dockerService.on("dns-update", dnsUpdateSpy);

      const mockContainer = {
        Name: "/container1",
        Config: {
          Labels: {
            "dns.cloudflare.hostname": "test.domain.com",
          },
        },
        State: {
          Status: "running",
        },
      };

      mockDocker.getContainer.mockReturnValue({
        inspect: jest.fn().mockResolvedValue(mockContainer),
      } as any);

      mockEventStream.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            Type: "container",
            Action: "start",
            Actor: {
              ID: "container1",
              Attributes: {
                name: "container1",
              },
            },
          })
        )
      );

      await Promise.resolve();

      expect(dnsUpdateSpy).toHaveBeenCalledWith({
        event: "start",
        service: "container1",
        labels: { "dns.cloudflare.hostname": "test.domain.com" },
      });
    });

    it("should handle container stop/destroy events", async () => {
      await dockerService.startMonitoring();
      mockDocker.listContainers.mockResolvedValue([]);

      const dnsRemoveSpy = jest.fn();
      dockerService.on("dns-remove", dnsRemoveSpy);

      mockEventStream.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            Type: "container",
            Action: "destroy",
            Actor: {
              ID: "container1",
              Attributes: {
                name: "container1",
              },
            },
          })
        )
      );

      await Promise.resolve();

      expect(dnsRemoveSpy).toHaveBeenCalledWith({
        event: "destroy",
        service: "container1",
      });
    });
  });
});
