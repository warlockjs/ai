import { describe, expect, it } from "vitest";
import { isPrivateOrReservedIp } from "./private-ip";

describe("isPrivateOrReservedIp", () => {
  it("flags private / loopback / link-local / metadata IPv4", () => {
    const blocked = [
      "0.0.0.0",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1", // CGNAT
      "127.0.0.1", // loopback
      "169.254.0.1", // link-local
      "169.254.169.254", // cloud metadata
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "224.0.0.1", // multicast
      "255.255.255.255",
    ];
    for (const ip of blocked) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    const allowed = ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "11.0.0.1"];
    for (const ip of allowed) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(false);
    }
  });

  it("flags loopback / unique-local / link-local IPv6 and mapped-v4", () => {
    const blocked = [
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1", // IPv4-mapped loopback
      "::ffff:169.254.169.254", // IPv4-mapped metadata
    ];
    for (const ip of blocked) {
      expect(isPrivateOrReservedIp(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6 and returns false for non-IP strings", () => {
    expect(isPrivateOrReservedIp("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateOrReservedIp("example.com")).toBe(false);
    expect(isPrivateOrReservedIp("not-an-ip")).toBe(false);
  });
});
