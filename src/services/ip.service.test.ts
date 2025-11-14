import { IPService } from "./ip.service";
import axios from "axios";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe("IPService", () => {
  let ipService: IPService;

  beforeEach(() => {
    ipService = IPService.getInstance();
    // Reset singleton state
    ipService["currentIPv4"] = null;
    ipService["currentIPv6"] = null;
    ipService["lastCheckIPv4"] = 0;
    ipService["lastCheckIPv6"] = 0;
    jest.clearAllMocks();
  });

  describe("IPv4 Tests", () => {
    it("should fetch IPv4 via Cloudflare trace endpoint", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: "ip=1.2.3.4\nts=1234567890\nuag=test\n",
      });

      const ip = await ipService.getPublicIPv4();
      expect(ip).toBe("1.2.3.4");
      expect(mockedAxios.get).toHaveBeenCalledWith(
        "https://1.1.1.1/cdn-cgi/trace",
        expect.objectContaining({
          timeout: 5000,
        })
      );
    });

    it("should fallback to other providers if Cloudflare fails", async () => {
      ipService["currentIPv4"] = null;
      mockedAxios.get
        .mockRejectedValueOnce(new Error("Cloudflare error")) // Cloudflare fails
        .mockResolvedValueOnce({ data: { ip: "1.2.3.4" } }) // ipify
        .mockResolvedValueOnce({ data: "1.2.3.4" }); // ifconfig.me

      const ip = await ipService.getPublicIPv4();
      expect(ip).toBe("1.2.3.4");
      expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    });

    it("should cache IPv4 address", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: "ip=1.2.3.4\nts=1234567890\n",
      });

      const ip1 = await ipService.getPublicIPv4();
      expect(ip1).toBe("1.2.3.4");
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // Should use cached value
      const ip2 = await ipService.getPublicIPv4();
      expect(ip2).toBe("1.2.3.4");
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it("should throw error if fallback IPs don't match", async () => {
      mockedAxios.get
        .mockRejectedValueOnce(new Error("Cloudflare error"))
        .mockResolvedValueOnce({ data: { ip: "1.2.3.4" } })
        .mockResolvedValueOnce({ data: "5.6.7.8" });

      await expect(ipService.getPublicIPv4()).rejects.toThrow(
        "IP addresses from different sources don't match"
      );
    });
  });

  describe("IPv6 Tests", () => {
    it("should fetch IPv6 via Cloudflare trace endpoint", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: "ip=2001:db8::1\nts=1234567890\nuag=test\n",
      });

      const ip = await ipService.getPublicIPv6();
      expect(ip).toBe("2001:db8::1");
      expect(mockedAxios.get).toHaveBeenCalledWith(
        "https://[2606:4700:4700::1111]/cdn-cgi/trace",
        expect.objectContaining({
          timeout: 5000,
        })
      );
    });

    it("should cache IPv6 address", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: "ip=2001:db8::1\nts=1234567890\n",
      });

      const ip1 = await ipService.getPublicIPv6();
      expect(ip1).toBe("2001:db8::1");
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);

      // Should use cached value
      const ip2 = await ipService.getPublicIPv6();
      expect(ip2).toBe("2001:db8::1");
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it("should use cached IPv6 if fetch fails", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: "ip=2001:db8::1\nts=1234567890\n",
      });

      const ip1 = await ipService.getPublicIPv6();
      expect(ip1).toBe("2001:db8::1");

      // Subsequent failed fetch
      mockedAxios.get.mockRejectedValue(new Error("Network error"));

      const ip2 = await ipService.getPublicIPv6();
      expect(ip2).toBe("2001:db8::1");
    });

    it("should throw error if no cached IPv6 and fetch fails", async () => {
      mockedAxios.get.mockRejectedValue(new Error("Network error"));

      await expect(ipService.getPublicIPv6()).rejects.toThrow(
        "Network error"
      );
    });
  });

  describe("getPublicIP wrapper", () => {
    it("should fetch IPv4 for type A", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: "ip=1.2.3.4\nts=1234567890\n",
      });

      const ip = await ipService.getPublicIP("A");
      expect(ip).toBe("1.2.3.4");
    });

    it("should fetch IPv6 for type AAAA", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: "ip=2001:db8::1\nts=1234567890\n",
      });

      const ip = await ipService.getPublicIP("AAAA");
      expect(ip).toBe("2001:db8::1");
    });

    it("should default to IPv4 if no type provided", async () => {
      mockedAxios.get.mockResolvedValueOnce({
        data: "ip=1.2.3.4\nts=1234567890\n",
      });

      const ip = await ipService.getPublicIP();
      expect(ip).toBe("1.2.3.4");
    });
  });

  describe("Cache management", () => {
    it("should maintain separate caches for IPv4 and IPv6", async () => {
      mockedAxios.get
        .mockResolvedValueOnce({
          data: "ip=1.2.3.4\nts=1234567890\n",
        })
        .mockResolvedValueOnce({
          data: "ip=2001:db8::1\nts=1234567890\n",
        });

      const ipv4 = await ipService.getPublicIPv4();
      const ipv6 = await ipService.getPublicIPv6();

      expect(ipv4).toBe("1.2.3.4");
      expect(ipv6).toBe("2001:db8::1");

      // Both should be cached now
      const ipv4Cached = await ipService.getPublicIPv4();
      const ipv6Cached = await ipService.getPublicIPv6();

      expect(ipv4Cached).toBe("1.2.3.4");
      expect(ipv6Cached).toBe("2001:db8::1");
      expect(mockedAxios.get).toHaveBeenCalledTimes(2); // Only initial fetches
    });

    it("should refresh cache after timeout", async () => {
      jest.useFakeTimers();
      ipService["currentIPv4"] = null;
      ipService["lastCheckIPv4"] = 0;

      mockedAxios.get.mockResolvedValueOnce({
        data: "ip=1.2.3.4\nts=1234567890\n",
      });

      const ip1 = await ipService.getPublicIPv4();
      expect(ip1).toBe("1.2.3.4");

      jest.advanceTimersByTime(6 * 60 * 1000);
      ipService["lastCheckIPv4"] = 0; // Force cache expiration

      mockedAxios.get.mockResolvedValueOnce({
        data: "ip=5.6.7.8\nts=1234567890\n",
      });

      await Promise.resolve();
      await Promise.resolve();
      const ip2 = await ipService.getPublicIPv4();
      expect(ip2).toBe("5.6.7.8");
      jest.useRealTimers();
    });
  });
});
