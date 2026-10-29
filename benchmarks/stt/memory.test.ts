import { describe, expect, test } from "bun:test";
import { peakRssInvocation } from "./memory";

describe("peakRssInvocation", () => {
  test("wraps the command in /usr/bin/time and hands the measured process the caller's env", () => {
    const invocation = peakRssInvocation(["/bin/parakeet-cli", "transcribe"], {
      platform: "macos",
      env: { PATH: "/usr/bin", PARAKEET_ATT_CONTEXT: "128" },
    });

    expect(invocation.argv).toEqual([
      "/usr/bin/time",
      "-l",
      "/bin/parakeet-cli",
      "transcribe",
    ]);
    expect(invocation.env.PARAKEET_ATT_CONTEXT).toBe("128");
    expect(invocation.env.PATH).toBe("/usr/bin");
    // The locale stays forced, so `/usr/bin/time`'s report parses whatever the caller sent.
    expect(invocation.env.LC_ALL).toBe("en_US.UTF-8");
    expect(invocation.env.LANG).toBe("en_US.UTF-8");
  });

  test("without an env, the measured process gets this process's own", () => {
    const invocation = peakRssInvocation(["crispasr"], { platform: "linux" });

    expect(invocation.argv).toEqual(["/usr/bin/time", "-v", "crispasr"]);
    expect(invocation.env.PATH).toBe(process.env.PATH);
    expect(invocation.env.PARAKEET_ATT_CONTEXT).toBeUndefined();
  });
});
