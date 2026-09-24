import { describe, expect, it } from "vitest";
import { lintCopy } from "@fstack/core";
import { CLUSTERS } from "@/lib/cluster";
import { LANDING_COPY, landingStrings, videoEmbed } from "@/lib/landing";

describe("landing copy (SPEC 9.1 / 13)", () => {
  it("every landing string passes lintCopy", () => {
    const strings = landingStrings(LANDING_COPY);
    expect(strings.length).toBeGreaterThan(30);
    for (const s of strings) expect(lintCopy(s), s).toEqual([]);
  });

  it("the whole landing text lints clean when joined", () => {
    expect(lintCopy(landingStrings().join("\n"))).toEqual([]);
  });

  it("honest framing makes no cluster claim of its own; cluster banners lint clean", () => {
    for (const s of landingStrings(LANDING_COPY.honest)) expect(s).not.toMatch(/mainnet|devnet/i);
    for (const c of Object.values(CLUSTERS)) expect(lintCopy(c.copy.banner)).toEqual([]);
  });

  it("videoEmbed: empty hides, YouTube/Loom embed, files play", () => {
    expect(videoEmbed("")).toBeNull();
    expect(videoEmbed("https://www.youtube.com/watch?v=abcDEF12345")).toEqual({
      kind: "iframe",
      src: "https://www.youtube-nocookie.com/embed/abcDEF12345",
    });
    expect(videoEmbed("https://youtu.be/abcDEF12345")?.src).toContain("/embed/abcDEF12345");
    expect(videoEmbed("https://www.loom.com/share/0123abc")?.src).toBe("https://www.loom.com/embed/0123abc");
    expect(videoEmbed("https://cdn.example/demo.mp4")).toEqual({ kind: "video", src: "https://cdn.example/demo.mp4" });
  });
});
