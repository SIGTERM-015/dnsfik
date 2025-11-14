import axios from "axios";
import { Logger } from "../utils/logger";

export class IPService {
  private static instance: IPService;
  private logger = Logger.getInstance();
  private currentIPv4: string | null = null;
  private currentIPv6: string | null = null;
  private lastCheckIPv4: number = 0;
  private lastCheckIPv6: number = 0;
  private readonly CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

  private constructor() {}

  public static getInstance(): IPService {
    if (!IPService.instance) {
      IPService.instance = new IPService();
    }
    return IPService.instance;
  }

  public async getPublicIP(type: "A" | "AAAA" = "A"): Promise<string> {
    if (type === "AAAA") {
      return this.getPublicIPv6();
    }
    return this.getPublicIPv4();
  }

  public async getPublicIPv4(): Promise<string> {
    if (this.currentIPv4 && Date.now() - this.lastCheckIPv4 < this.CACHE_DURATION) {
      return this.currentIPv4;
    }

    try {
      // Try Cloudflare trace endpoint first, fallback to other providers
      let ip: string;
      try {
        ip = await this.fetchIPViaCloudflareDOH("A");
        this.logger.debug("Fetched IPv4 via Cloudflare", { ip });
      } catch (cfError) {
        this.logger.warn("Failed to fetch IPv4 via Cloudflare, trying fallback providers", { error: cfError });
        const [ip1, ip2] = await Promise.all([
          this.fetchIP("https://api.ipify.org?format=json"),
          this.fetchIP("https://ifconfig.me/ip"),
        ]);

        if (ip1 !== ip2) {
          throw new Error("IP addresses from different sources don't match");
        }
        ip = ip1;
      }

      this.currentIPv4 = ip;
      this.lastCheckIPv4 = Date.now();
      return ip;
    } catch (error) {
      this.logger.error("Failed to fetch public IPv4", { error });
      if (this.currentIPv4) {
        this.logger.warn("Using cached IPv4 address", { ip: this.currentIPv4 });
        return this.currentIPv4;
      }
      throw error;
    }
  }

  public async getPublicIPv6(): Promise<string> {
    if (this.currentIPv6 && Date.now() - this.lastCheckIPv6 < this.CACHE_DURATION) {
      return this.currentIPv6;
    }

    try {
      const ip = await this.fetchIPViaCloudflareDOH("AAAA");
      this.logger.debug("Fetched IPv6 via Cloudflare", { ip });
      this.currentIPv6 = ip;
      this.lastCheckIPv6 = Date.now();
      return ip;
    } catch (error) {
      this.logger.error("Failed to fetch public IPv6", { error });
      if (this.currentIPv6) {
        this.logger.warn("Using cached IPv6 address", { ip: this.currentIPv6 });
        return this.currentIPv6;
      }
      throw error;
    }
  }

  private async fetchIPViaCloudflareDOH(type: "A" | "AAAA"): Promise<string> {
    try {
      // Use Cloudflare's trace endpoint
      const endpoint = type === "AAAA" 
        ? "https://[2606:4700:4700::1111]/cdn-cgi/trace"  // IPv6 endpoint
        : "https://1.1.1.1/cdn-cgi/trace";                 // IPv4 endpoint
      
      const response = await axios.get(endpoint, {
        timeout: 5000,
      });

      if (!response.data) {
        throw new Error("No response from Cloudflare trace endpoint");
      }

      // Parse the response which is in key=value format
      // Example: "ip=1.2.3.4\nts=1234567890\nuag=...\n"
      const lines = response.data.split('\n');
      const ipLine = lines.find((line: string) => line.startsWith('ip='));
      
      if (!ipLine) {
        throw new Error("No IP address in Cloudflare trace response");
      }

      const ip = ipLine.split('=')[1].trim();
      if (!ip) {
        throw new Error("Invalid IP address in response");
      }

      return ip;
    } catch (error: any) {
      // Provide helpful error message for IPv6 connectivity issues
      if (type === "AAAA" && error.code === "ENETUNREACH") {
        const helpfulError = new Error(
          "IPv6 is not available in this Docker container. " +
          "To enable IPv6 support, configure Docker daemon with IPv6. " +
          "See README.md for instructions."
        );
        this.logger.error(`Failed to fetch ${type} via Cloudflare trace endpoint`, { 
          error: helpfulError.message,
          hint: "AAAA records require IPv6 to be enabled in Docker daemon"
        });
        throw helpfulError;
      }
      
      this.logger.error(`Failed to fetch ${type} via Cloudflare trace endpoint`, { error });
      throw error;
    }
  }

  private async fetchIP(url: string): Promise<string> {
    try {
      const response = await axios.get(url);
      return typeof response.data === "string"
        ? response.data.trim()
        : response.data.ip.trim();
    } catch (error) {
      this.logger.error(`Failed to fetch IP from ${url}`, { error });
      throw error;
    }
  }
}
