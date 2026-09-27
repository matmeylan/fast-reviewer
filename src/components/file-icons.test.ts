import { describe, expect, it } from "vitest";
import { fileIconName, iconUrls, USED_ICONS } from "./file-icons";

describe("file icons", () => {
  it("maps extensions and well-known names", () => {
    expect(fileIconName("src/App.tsx")).toBe("typeScript");
    expect(fileIconName("api/routes/orders.py")).toBe("python");
    expect(fileIconName("web/styles.css")).toBe("css");
    expect(fileIconName("README.md")).toBe("markdown");
    expect(fileIconName("pnpm-lock.yaml")).toBe("yaml");
    expect(fileIconName("docker/Dockerfile")).toBe("docker");
    expect(fileIconName(".gitignore")).toBe("gitignore");
    expect(fileIconName(".env.local")).toBe("config");
    expect(fileIconName("web/assets/logo.PNG")).toBe("image");
  });

  it("falls back to the generic icon", () => {
    expect(fileIconName("Makefile")).toBe("anyType");
    expect(fileIconName("src/main.rs")).toBe("anyType");
  });

  it("ships an asset for every icon it can return", () => {
    for (const name of USED_ICONS) expect(iconUrls(name), name).toBeDefined();
    expect(iconUrls("nope")).toBeUndefined();
  });
});
