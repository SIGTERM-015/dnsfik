import { DNSService } from "./dns.service";
import { CloudflareService } from "./cloudflare.service";
import { IPService } from "./ip.service";
import { TaskWorker } from "../workers/task.worker";
import { LabelValidator } from "../utils/validators";
import { DockerService } from "./docker.service";

jest.mock("./cloudflare.service");
jest.mock("./ip.service");
jest.mock("../workers/task.worker");
jest.mock("./docker.service");

describe("DNSService", () => {
  let dnsService: DNSService;
  let mockCloudflare: jest.Mocked<CloudflareService>;
  let mockIpService: jest.Mocked<IPService>;
  let mockTaskWorker: jest.Mocked<TaskWorker>;
  let mockDocker: jest.Mocked<DockerService>;
  let validator: LabelValidator;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    // Reset singleton
    (DNSService as any).instance = undefined;

    // Setup mocks
    mockCloudflare = {
      getInstance: jest.fn().mockReturnThis(),
      getDNSRecord: jest.fn(),
      createDNSRecord: jest.fn(),
      updateDNSRecord: jest.fn(),
      deleteDNSRecord: jest.fn(),
    } as any;

    mockIpService = {
      getInstance: jest.fn().mockReturnThis(),
      getPublicIP: jest.fn().mockResolvedValue("1.2.3.4"),
    } as any;

    mockTaskWorker = {
      getInstance: jest.fn().mockReturnThis(),
      addTask: jest.fn().mockResolvedValue(undefined),
    } as any;

    mockDocker = {
      getInstance: jest.fn().mockReturnThis(),
      getContainer: jest.fn().mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Config: {
            Labels: {}, // Les labels seront fournis dans chaque test
          },
        }),
      }),
    } as any;

    // Mock getInstance methods
    (CloudflareService.getInstance as jest.Mock).mockReturnValue(
      mockCloudflare
    );
    (IPService.getInstance as jest.Mock).mockReturnValue(mockIpService);
    (TaskWorker.getInstance as jest.Mock).mockReturnValue(mockTaskWorker);
    (DockerService.getInstance as jest.Mock).mockReturnValue(mockDocker);

    dnsService = DNSService.getInstance();
    validator = new LabelValidator();
  });

  describe("handleServiceUpdate", () => {
    it("should create new DNS record when none exists", async () => {
      const labels = {
        "dns.cloudflare.hostname": "test.domain.com",
        "dns.cloudflare.type": "A",
      };

      mockCloudflare.getDNSRecord.mockResolvedValue(null);

      mockDocker.getContainer.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Config: { Labels: labels },
        }),
      } as any);

      await dnsService.handleServiceUpdate("test-service", labels);

      expect(mockTaskWorker.addTask).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CREATE",
          data: expect.objectContaining({
            serviceName: "test-service",
            name: "test.domain.com",
            recordType: "A",
            content: "1.2.3.4",
          }),
        })
      );
    });

    it("should update existing DNS record when content changes", async () => {
      const labels = {
        "dns.cloudflare.hostname": "test.domain.com",
        "dns.cloudflare.type": "A",
        "dns.cloudflare.content": "5.6.7.8",
      };

      mockDocker.getContainer.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Config: { Labels: labels },
        }),
      } as any);

      mockCloudflare.getDNSRecord.mockResolvedValue({
        id: "record123",
        type: "A",
        name: "test.domain.com",
        content: "1.2.3.4",
        ttl: 1,
        proxied: true,
      });

      await dnsService.handleServiceUpdate("test-service", labels);

      expect(mockTaskWorker.addTask).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "UPDATE",
          data: expect.objectContaining({
            recordId: "record123",
            content: "5.6.7.8",
          }),
        })
      );
    });

    it("should not update when record is unchanged", async () => {
      // Mock un enregistrement existant
      mockCloudflare.getDNSRecord.mockResolvedValue({
        id: "record123",
        type: "A",
        name: "test.domain.com",
        content: "1.2.3.4",
        proxied: true, // Important : doit correspondre à la valeur par défaut
        ttl: 1,
      });

      const labels = {
        "dns.cloudflare.hostname": "test.domain.com",
        "dns.cloudflare.type": "A",
      };

      await dnsService.handleServiceUpdate("test-service", labels);

      expect(mockTaskWorker.addTask).not.toHaveBeenCalled();
    });

    it("should handle multiple DNS records", async () => {
      const labels = {
        "dns.cloudflare.hostname": "api.domain.com",
        "dns.cloudflare.type": "A",
        "dns.cloudflare.hostname.v6": "api.domain.com",
        "dns.cloudflare.type.v6": "AAAA",
        "dns.cloudflare.content.v6": "2001:db8::1",
      };

      mockDocker.getContainer.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Config: { Labels: labels },
        }),
      } as any);

      mockCloudflare.getDNSRecord
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      await dnsService.handleServiceUpdate("test-service", labels);

      expect(mockTaskWorker.addTask).toHaveBeenCalledTimes(2);
      expect(mockTaskWorker.addTask).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CREATE",
          data: expect.objectContaining({
            recordType: "A",
            content: "1.2.3.4",
          }),
        })
      );
      expect(mockTaskWorker.addTask).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CREATE",
          data: expect.objectContaining({
            recordType: "AAAA",
            content: "2001:db8::1",
          }),
        })
      );
    });

    it("should skip AAAA record if IPv6 fetch fails but continue with A record", async () => {
      const labels = {
        "dns.cloudflare.hostname": "api.domain.com",
        "dns.cloudflare.type": "A",
        "dns.cloudflare.hostname.v6": "api.domain.com",
        "dns.cloudflare.type.v6": "AAAA",
      };

      mockDocker.getContainer.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Config: { Labels: labels },
        }),
      } as any);

      mockCloudflare.getDNSRecord
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);

      // IPv4 succeeds, IPv6 fails
      mockIpService.getPublicIP
        .mockResolvedValueOnce("1.2.3.4")
        .mockRejectedValueOnce(new Error("IPv6 is not available in this Docker container"));

      await dnsService.handleServiceUpdate("test-service", labels);

      // Should only create A record, AAAA should be skipped
      expect(mockTaskWorker.addTask).toHaveBeenCalledTimes(1);
      expect(mockTaskWorker.addTask).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CREATE",
          data: expect.objectContaining({
            recordType: "A",
            content: "1.2.3.4",
          }),
        })
      );
    });

    it("should throw error if IPv4 fetch fails", async () => {
      const labels = {
        "dns.cloudflare.hostname": "api.domain.com",
        "dns.cloudflare.type": "A",
      };

      mockDocker.getContainer.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Config: { Labels: labels },
        }),
      } as any);

      mockCloudflare.getDNSRecord.mockResolvedValueOnce(null);

      // IPv4 fails - should throw
      mockIpService.getPublicIP.mockRejectedValueOnce(new Error("Network error"));

      await expect(
        dnsService.handleServiceUpdate("test-service", labels)
      ).rejects.toThrow("Network error");
    });

    it("should use content from label with public_ip keyword", async () => {
      const labels = {
        "dns.cloudflare.hostname": "api.domain.com",
        "dns.cloudflare.type": "A",
        "dns.cloudflare.content": "public_ip",
      };

      mockDocker.getContainer.mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Config: { Labels: labels },
        }),
      } as any);

      mockCloudflare.getDNSRecord.mockResolvedValueOnce(null);
      mockIpService.getPublicIP.mockResolvedValueOnce("5.6.7.8");

      await dnsService.handleServiceUpdate("test-service", labels);

      expect(mockTaskWorker.addTask).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "CREATE",
          data: expect.objectContaining({
            content: "5.6.7.8",
          }),
        })
      );
    });

    it("should handle errors gracefully", async () => {
      const labels = {
        "dns.cloudflare.hostname": "test.domain.com",
        "dns.cloudflare.type": "A",
      };

      mockDocker.getContainer.mockReturnValue({
        inspect: jest.fn().mockRejectedValue(new Error("API Error")),
      } as any);

      await expect(
        dnsService.handleServiceUpdate("test-service", labels)
      ).rejects.toThrow("API Error");
    });

    it("should use correct defaults for different record types", () => {
      const labels = {
        "dns.cloudflare.hostname": "app.domain.com",
        "dns.cloudflare.type": "A", // devrait avoir proxied=true
      };
      const result = validator.validateServiceLabels("test-service", labels);
      expect(result[0].proxied).toBe(true);

      const labelsAAAA = {
        "dns.cloudflare.hostname": "app.domain.com",
        "dns.cloudflare.type": "AAAA", // devrait avoir proxied=false
        "dns.cloudflare.content": "2001:db8::1",
      };
      const resultAAAA = validator.validateServiceLabels(
        "test-service",
        labelsAAAA
      );
      expect(resultAAAA[0].proxied).toBe(false);
    });
  });

  describe("checkAndUpdateIPAddresses", () => {
    beforeEach(() => {
      // Add necessary mocks for IP service
      mockIpService.getPublicIPv4 = jest.fn();
      mockIpService.getPublicIPv6 = jest.fn();
    });

    it("should update records when IPv4 changes", async () => {
      // Setup initial IP
      dnsService["lastKnownIPv4"] = "1.2.3.4";
      
      // Mock new IPv4
      mockIpService.getPublicIPv4.mockResolvedValue("5.6.7.8");
      mockIpService.getPublicIPv6.mockRejectedValue(new Error("IPv6 not available"));

      // Mock Docker containers list
      mockDocker["docker"] = {
        listContainers: jest.fn().mockResolvedValue([]),
      } as any;

      await dnsService.checkAndUpdateIPAddresses();

      expect(dnsService["lastKnownIPv4"]).toBe("5.6.7.8");
    });

    it("should not update records when IPv4 unchanged", async () => {
      // Setup initial IP
      dnsService["lastKnownIPv4"] = "1.2.3.4";
      
      // Mock same IPv4
      mockIpService.getPublicIPv4.mockResolvedValue("1.2.3.4");
      mockIpService.getPublicIPv6.mockRejectedValue(new Error("IPv6 not available"));

      await dnsService.checkAndUpdateIPAddresses();

      expect(dnsService["lastKnownIPv4"]).toBe("1.2.3.4");
    });

    it("should handle IPv6 failure gracefully", async () => {
      dnsService["lastKnownIPv4"] = null;
      
      mockIpService.getPublicIPv4.mockResolvedValue("1.2.3.4");
      mockIpService.getPublicIPv6.mockRejectedValue(new Error("IPv6 not available"));

      await expect(
        dnsService.checkAndUpdateIPAddresses()
      ).resolves.not.toThrow();

      expect(dnsService["lastKnownIPv4"]).toBe("1.2.3.4");
    });

    it("should update records when IPv6 changes", async () => {
      // Setup initial IPs
      dnsService["lastKnownIPv4"] = "1.2.3.4";
      dnsService["lastKnownIPv6"] = "2001:db8::1";
      
      // Mock same IPv4 but changed IPv6
      mockIpService.getPublicIPv4.mockResolvedValue("1.2.3.4");
      mockIpService.getPublicIPv6.mockResolvedValue("2001:db8::2");

      // Mock Docker containers list
      mockDocker["docker"] = {
        listContainers: jest.fn().mockResolvedValue([]),
      } as any;

      await dnsService.checkAndUpdateIPAddresses();

      expect(dnsService["lastKnownIPv6"]).toBe("2001:db8::2");
    });

    it("should throw error if IPv4 fetch fails", async () => {
      mockIpService.getPublicIPv4.mockRejectedValue(new Error("Network error"));

      await expect(
        dnsService.checkAndUpdateIPAddresses()
      ).rejects.toThrow("Network error");
    });

    it("should update DNS records when IPv4 changes and containers have public_ip", async () => {
      // Setup initial IP
      dnsService["lastKnownIPv4"] = "1.2.3.4";
      
      // Mock new IPv4
      mockIpService.getPublicIPv4.mockResolvedValue("5.6.7.8");
      mockIpService.getPublicIPv6.mockRejectedValue(new Error("IPv6 not available"));

      // Mock Docker containers with labels
      const mockContainer = {
        Id: "container123",
        Names: ["/test-service"],
      };

      mockDocker["docker"] = {
        listContainers: jest.fn().mockResolvedValue([mockContainer]),
      } as any;

      mockDocker.getContainer = jest.fn().mockReturnValue({
        inspect: jest.fn().mockResolvedValue({
          Config: {
            Labels: {
              "dns.cloudflare.hostname": "api.domain.com",
              "dns.cloudflare.type": "A",
              "dns.cloudflare.content": "public_ip",
            },
          },
        }),
      });

      mockCloudflare.getDNSRecord.mockResolvedValue({
        id: "record123",
        type: "A",
        name: "api.domain.com",
        content: "1.2.3.4",
        ttl: 1,
        proxied: true,
      });

      await dnsService.checkAndUpdateIPAddresses();

      expect(mockTaskWorker.addTask).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "UPDATE",
          data: expect.objectContaining({
            content: "5.6.7.8",
          }),
        })
      );
    });
  });
});
