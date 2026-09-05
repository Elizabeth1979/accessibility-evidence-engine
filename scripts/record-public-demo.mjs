import { createServer } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import {
  proposeAccessibleLabelFix,
  routeContextualReview,
  suggestPaletteContrastFix
} from "@aee/ai-fixes";
import {
  comparePointerAndKeyboardOutcomes,
  runAeeOnPage,
  verifyMotionControl
} from "@aee/playwright";

const projectRoot = process.cwd();
const siteRoot = path.join(projectRoot, "site");
const issueRunId = "recorded-modal-focus-issue";
const fixedRunId = "recorded-modal-focus-fixed";
const outputRoot = path.join(siteRoot, "demo-artifacts");
const port = Number.parseInt(process.env.AEE_DEMO_PORT ?? "4173", 10);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webm", "video/webm"]
]);

await Promise.all([
  rm(path.join(outputRoot, "recorded-keyboard-save"), { recursive: true, force: true }),
  rm(path.join(outputRoot, "recorded-keyboard-save-issue"), { recursive: true, force: true }),
  rm(path.join(outputRoot, "recorded-keyboard-save-fixed"), { recursive: true, force: true }),
  rm(path.join(outputRoot, issueRunId), { recursive: true, force: true }),
  rm(path.join(outputRoot, fixedRunId), { recursive: true, force: true }),
  rm(path.join(outputRoot, "axe-unnamed-icon.json"), { force: true }),
  rm(path.join(outputRoot, "axe-named-icon.json"), { force: true }),
  rm(path.join(outputRoot, "axe-open-dialog.json"), { force: true }),
  rm(path.join(outputRoot, "ai-label-suggestion.json"), { force: true }),
  rm(path.join(outputRoot, "heading-structure"), { recursive: true, force: true }),
  rm(path.join(outputRoot, "axe-heading-structure.json"), { force: true }),
  rm(path.join(outputRoot, "ai-heading-suggestion.json"), { force: true }),
  rm(path.join(outputRoot, "icon-label"), { recursive: true, force: true }),
  rm(path.join(outputRoot, "palette-contrast"), { recursive: true, force: true }),
  rm(path.join(outputRoot, "hover-keyboard"), { recursive: true, force: true }),
  rm(path.join(outputRoot, "motion-control"), { recursive: true, force: true }),
  rm(path.join(outputRoot, "playwright-aee-demo.mp4"), { force: true }),
  rm(path.join(outputRoot, "playwright-aee-demo.webm"), { force: true })
]);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
    const targetPath = path.resolve(siteRoot, relativePath);

    if (!targetPath.startsWith(`${siteRoot}${path.sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    const body = await readFile(targetPath);
    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(targetPath)) ?? "application/octet-stream"
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

let browser;

try {
  browser = await chromium.launch({ headless: true });
  await generateAxeEvidence(browser);
  await generateReviewedAiSuggestion();
  await generateIconLabelStory(browser);
  await generateHeadingStructureStory(browser);
  await generatePaletteContrastStory(browser);
  await generateHoverKeyboardStory(browser);
  await generateMotionControlStory(browser);
  const issueResult = await runEvidenceScenario(browser, {
    focusImplementation: "broken",
    runId: issueRunId,
    expectedVerdict: "fail"
  });
  const fixedResult = await runEvidenceScenario(browser, {
    focusImplementation: "fixed",
    runId: fixedRunId,
    expectedVerdict: "pass"
  });

  await normalizeRunOutput(issueRunId, issueResult.reporterFiles);
  await normalizeRunOutput(fixedRunId, fixedResult.reporterFiles);
  await assertRunVerdicts(issueRunId, "fail");
  await assertRunVerdicts(fixedRunId, "pass");

  console.log(
    `Generated public demo images and AEE evidence in ${path.relative(projectRoot, outputRoot)}.`
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}

async function generateAxeEvidence(activeBrowser) {
  const context = await activeBrowser.newContext({
    colorScheme: "dark",
    viewport: { width: 1280, height: 720 }
  });

  try {
    const page = await context.newPage();
    await prepareRecordingPage(page, { label: "missing", focus: "broken" });
    const unnamedResult = await new AxeBuilder({ page }).withRules(["button-name"]).analyze();
    const buttonNameViolation = unnamedResult.violations.find(
      (violation) => violation.id === "button-name"
    );

    if (!buttonNameViolation?.nodes.some((node) => node.target.includes("#delete-project"))) {
      throw new Error("Expected axe to find the unnamed delete icon button.");
    }

    await writeAxeArtifact("axe-unnamed-icon.json", unnamedResult);
    await page.locator("#delete-project").evaluate((button) => {
      button.setAttribute("aria-label", "Delete Project Alpha");
    });
    const namedResult = await new AxeBuilder({ page }).withRules(["button-name"]).analyze();

    if (namedResult.violations.some((violation) => violation.id === "button-name")) {
      throw new Error("Expected axe button-name to pass after applying the contextual label.");
    }

    await writeAxeArtifact("axe-named-icon.json", namedResult);
    await page.getByRole("button", { name: "Delete Project Alpha" }).click();
    const openDialogResult = await new AxeBuilder({ page })
      .withRules(["button-name", "aria-dialog-name"])
      .analyze();

    if (openDialogResult.violations.length > 0) {
      throw new Error(
        `Expected the named open-dialog state to pass the selected axe rules: ${openDialogResult.violations.map((violation) => violation.id).join(", ")}`
      );
    }

    await writeAxeArtifact("axe-open-dialog.json", openDialogResult);
  } finally {
    await context.close();
  }
}

async function generateReviewedAiSuggestion() {
  const labelContext = {
    selector: "#delete-project",
    role: "button",
    iconDescription: "trash can",
    nearbyHeading: "Project Alpha",
    nearbyText: "Production workspace",
    destinationText: "Delete Project Alpha? This action cannot be undone."
  };
  const routing = routeContextualReview({
    kind: "icon-label",
    hasAccessibleName: false,
    isIconOnly: true,
    contextSignals: ["trash can icon", "Project Alpha heading", "destructive dialog copy"]
  });
  const fix = await proposeAccessibleLabelFix(labelContext, {
    id: "codex-reviewed-demo-suggestion",
    async suggestLabel() {
      return {
        label: "Delete Project Alpha",
        rationale:
          "The trash icon, Project Alpha heading, and matching destructive confirmation copy establish the control's purpose and object.",
        confidence: 0.96
      };
    }
  });

  await writeFile(
    path.join(outputRoot, "ai-label-suggestion.json"),
    `${JSON.stringify(
      {
        schemaVersion: "0.1.0",
        generation: {
          mode: "reviewed-demo-example",
          liveModelCall: false,
          note: "This checked-in proposal was authored with Codex and reviewed for the public demo. CI does not receive API credentials. The @aee/ai-fixes package supports live, injected model providers."
        },
        routing,
        context: labelContext,
        proposal: fix,
        verificationRequired: true
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function generateIconLabelStory(activeBrowser) {
  const context = await activeBrowser.newContext({
    colorScheme: "dark",
    viewport: { width: 1120, height: 660 },
    deviceScaleFactor: 1
  });
  const iconOutput = path.join(outputRoot, "icon-label");
  await mkdir(iconOutput, { recursive: true });

  try {
    const page = await context.newPage();
    await page.setContent(iconLabelStoryMarkup("before"));
    await page.locator("#story-frame").screenshot({ path: path.join(iconOutput, "before.png") });
    await page.setContent(iconLabelStoryMarkup("after"));
    await page.locator("#story-frame").screenshot({ path: path.join(iconOutput, "after.png") });
  } finally {
    await context.close();
  }
}

function iconLabelStoryMarkup(stage) {
  const isBefore = stage === "before";
  const analysis = isBefore
    ? `<div class="badge fail">axe-core · Fail</div><h2>The button has no name</h2><div class="tree"><code>button</code><strong>accessible name: ""</strong></div><p>axe detects the objective defect. The trash symbol alone does not provide a name to assistive technology.</p>`
    : `<div class="badge review">AEE · Review</div><h2>“Delete Project Alpha”</h2><div class="signals"><span>trash icon</span><span>Project Alpha</span><span>delete confirmation</span></div><div class="tree pass"><code>button</code><strong>accessible name: "Delete Project Alpha"</strong></div><p>Context supplies the specific action and object. The reviewed label is applied, then axe passes on rerun.</p>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; } body { margin:0; padding:20px; background:#07110e; color:#f5fbf8; font-family:Inter,ui-sans-serif,system-ui,sans-serif; }
    #story-frame { width:1080px; height:620px; display:grid; grid-template-columns:1.08fr .92fr; gap:20px; padding:26px; border:1px solid #29463d; border-radius:20px; background:linear-gradient(145deg,#0d1d18,#09130f); }
    .browser { overflow:hidden; border:1px solid #36584d; border-radius:14px; background:#f6f2e9; color:#1b2824; } .chrome { display:flex; gap:7px; height:34px; padding:13px; background:#d9d4ca; } .chrome i { width:8px; height:8px; border-radius:50%; background:#8e8a82; }
    .page { padding:34px 28px; } .page h1 { margin:0 0 8px; font-size:30px; } .lede { margin:0 0 42px; color:#65706b; } .project { display:flex; align-items:center; justify-content:space-between; padding:24px; border:1px solid #d6d1c7; border-radius:14px; background:#fff; } .project strong { display:block; font-size:21px; } .project span { color:#68736e; }
    button { position:relative; display:grid; width:64px; height:64px; place-items:center; border:3px solid ${isBefore ? "#d84d4d" : "#2aa772"}; border-radius:14px; background:${isBefore ? "#fff0f0" : "#edfff6"}; color:${isBefore ? "#a52222" : "#126b49"}; } button svg { width:30px; fill:none; stroke:currentColor; stroke-width:2; } button::after { content:"${isBefore ? "no name" : "named"}"; position:absolute; top:72px; padding:5px 8px; border-radius:20px; background:${isBefore ? "#591b1b" : "#0b3a29"}; color:white; font:800 11px system-ui; white-space:nowrap; }
    .analysis { display:flex; flex-direction:column; justify-content:center; padding:8px 12px; } .analysis h2 { margin:16px 0 12px; font-size:31px; line-height:1.12; } .analysis p { color:#a9bbb4; line-height:1.48; }
    .badge { align-self:flex-start; padding:7px 10px; border-radius:999px; font-size:12px; font-weight:850; letter-spacing:.08em; text-transform:uppercase; } .fail { background:#4a1515; color:#ff9999; } .review { background:#3b2c08; color:#ffd76a; }
    .tree { display:grid; gap:7px; margin:8px 0; padding:16px; border:1px solid #723333; border-radius:11px; background:#190b0b; } .tree.pass { border-color:#237252; background:#071a12; } .tree code { color:#91a69e; font-weight:800; } .tree strong { font:700 15px ui-monospace,SFMono-Regular,monospace; }
    .signals { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:8px; } .signals span { padding:6px 9px; border:1px solid #7c651e; border-radius:999px; color:#ffe18a; font-size:12px; }
  </style></head><body><div id="story-frame"><div class="browser"><div class="chrome"><i></i><i></i><i></i></div><main class="page"><h1>Projects</h1><p class="lede">Manage your production workspaces.</p><div class="project"><div><strong>Project Alpha</strong><span>Production workspace</span></div><button ${isBefore ? "" : 'aria-label="Delete Project Alpha"'}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5m4-5v5"/></svg></button></div></main></div><section class="analysis">${analysis}</section></div></body></html>`;
}

async function generatePaletteContrastStory(activeBrowser) {
  const directory = path.join(outputRoot, "palette-contrast");
  await mkdir(directory, { recursive: true });
  const result = suggestPaletteContrastFix({
    selector: ".dashboard-card .secondary-copy",
    foreground: "#607a71",
    background: "#07110f",
    palette: [
      { name: "Muted", value: "#607a71" },
      { name: "Text subtle", value: "#91aaa2" },
      { name: "Accent", value: "#70f0b4" },
      { name: "Primary text", value: "#f1f8f5" }
    ]
  });
  await writeFile(
    path.join(directory, "evidence.json"),
    `${JSON.stringify({ schemaVersion: "0.1.0", kind: "palette-contrast", ...result }, null, 2)}\n`
  );

  const context = await activeBrowser.newContext({ viewport: { width: 1080, height: 620 } });
  try {
    const page = await context.newPage();
    for (const stage of ["before", "after"]) {
      await page.setContent(paletteStoryMarkup(stage, result));
      await page.locator("#story-frame").screenshot({ path: path.join(directory, `${stage}.png`) });
    }
  } finally {
    await context.close();
  }
}

function paletteStoryMarkup(stage, result) {
  const fixed = stage === "after";
  const color = fixed ? result.selected.value : "#607a71";
  const ratio = fixed ? result.selectedRatio : result.currentRatio;
  return advancedStoryShell(`
    <div class="sample palette-sample">
      <p class="sample-label">Quarterly overview</p>
      <h1>Revenue grew 18%</h1>
      <p class="secondary" style="color:${color}">Compared with the previous quarter</p>
      <div class="swatches"><i style="background:#607a71"></i><i style="background:#91aaa2"></i><i style="background:#70f0b4"></i><i style="background:#f1f8f5"></i></div>
    </div>
    <div class="analysis">
      <span class="badge ${fixed ? "pass" : "fail"}">${fixed ? "AEE · VERIFIED" : "CONTRAST · FAIL"}</span>
      <h2>${fixed ? "Closest passing palette color" : "Brand color does not contrast"}</h2>
      <div class="metric"><span>Foreground</span><strong>${color}</strong></div>
      <div class="metric"><span>Measured contrast</span><strong>${ratio.toFixed(2)}:1</strong></div>
      <div class="metric"><span>Required</span><strong>4.50:1</strong></div>
      <p>${fixed ? "AEE checks existing tokens and proposes Text subtle—not an invented color—for human review." : "The failure is objective. Choosing a compatible repair requires awareness of the product palette."}</p>
    </div>`);
}

async function generateHoverKeyboardStory(activeBrowser) {
  const directory = path.join(outputRoot, "hover-keyboard");
  await mkdir(directory, { recursive: true });
  const context = await activeBrowser.newContext({ viewport: { width: 1080, height: 620 } });
  try {
    const page = await context.newPage();
    const before = await measureHoverKeyboard(page, false);
    const after = await measureHoverKeyboard(page, true);
    await writeFile(
      path.join(directory, "evidence.json"),
      `${JSON.stringify({ schemaVersion: "0.1.0", kind: "pointer-keyboard-equivalence", before, after }, null, 2)}\n`
    );
    for (const [stage, result] of [
      ["before", before],
      ["after", after]
    ]) {
      await page.setContent(hoverStoryMarkup(stage, result));
      await page.locator("#story-frame").screenshot({ path: path.join(directory, `${stage}.png`) });
    }
  } finally {
    await context.close();
  }
}

async function measureHoverKeyboard(page, fixed) {
  const markup = `<!doctype html><style>
    #tip { display:none } #point:hover + #tip${fixed ? ", #point:focus + #tip" : ""} { display:block }
  </style><main><${fixed ? "button" : "div"} id="point">Q3</${fixed ? "button" : "div"}><p id="tip">Revenue increased 18 percent</p></main>`;
  await page.setContent(markup);
  return comparePointerAndKeyboardOutcomes({
    async reset() {
      await page.evaluate(() => {
        const activeElement = globalThis.document.activeElement;
        if (activeElement instanceof globalThis.HTMLElement) activeElement.blur();
      });
      await page.mouse.move(1000, 580);
    },
    async performPointerInteraction() {
      await page.locator("#point").hover();
    },
    async performKeyboardInteraction() {
      await page.keyboard.press("Tab");
    },
    async captureOutcome() {
      return page.locator("#tip").evaluate((element) => ({
        visible: globalThis.getComputedStyle(element).display !== "none",
        text: element.textContent?.trim() ?? ""
      }));
    }
  });
}

function hoverStoryMarkup(stage, result) {
  const fixed = stage === "after";
  return advancedStoryShell(`
    <div class="sample chart-sample">
      <p class="sample-label">Quarterly revenue</p><h1>$2.4M</h1>
      <div class="chart"><i></i><i></i><i class="active"></i><i></i></div>
      <div class="outcome"><span>Mouse hover</span><strong class="good">Tooltip shown</strong></div>
      <div class="outcome"><span>Keyboard focus</span><strong class="${fixed ? "good" : "bad"}">${fixed ? "Same tooltip shown" : "Nothing happens"}</strong></div>
    </div>
    <div class="analysis">
      <span class="badge ${fixed ? "pass" : "fail"}">AEE · ${result.verdict.toUpperCase()}</span>
      <h2>${fixed ? "Equivalent outcome verified" : "Hover-only information found"}</h2>
      <p>${fixed ? "The reset hover and keyboard paths reveal the same text." : "The same reset state produces different outcomes for mouse and keyboard."}</p>
      <div class="code">${fixed ? "button:hover + .tooltip\nbutton:focus + .tooltip" : ".point:hover + .tooltip"}</div>
    </div>`);
}

async function generateMotionControlStory(activeBrowser) {
  const directory = path.join(outputRoot, "motion-control");
  await mkdir(directory, { recursive: true });
  const context = await activeBrowser.newContext({ viewport: { width: 1080, height: 620 } });
  try {
    const page = await context.newPage();
    const before = await measureMotionControl(page, false);
    const after = await measureMotionControl(page, true);
    await writeFile(
      path.join(directory, "evidence.json"),
      `${JSON.stringify({ schemaVersion: "0.1.0", kind: "motion-control", before, after }, null, 2)}\n`
    );
    for (const [stage, result] of [
      ["before", before],
      ["after", after]
    ]) {
      await page.setContent(motionStoryMarkup(stage, result));
      await page.locator("#story-frame").screenshot({ path: path.join(directory, `${stage}.png`) });
    }
  } finally {
    await context.close();
  }
}

async function measureMotionControl(page, fixed) {
  await page.setContent(`<!doctype html><style>
    #ticker { width:120px; animation:travel .35s linear infinite } @keyframes travel { to { transform:translateX(160px) } }
  </style><div id="ticker">Breaking news</div><button id="pause">Pause animation</button>
  <script>document.querySelector('#pause').addEventListener('click', () => { ${fixed ? "document.querySelector('#ticker').getAnimations().forEach(animation => animation.cancel())" : "void 0"} })</script>`);
  return verifyMotionControl({
    settleMs: 70,
    async sample() {
      return page.locator("#ticker").evaluate((element) => ({
        activeAnimations: element
          .getAnimations()
          .filter((animation) => animation.playState === "running").length,
        signature: globalThis.getComputedStyle(element).transform
      }));
    },
    async requestStop() {
      await page.locator("#pause").click();
    }
  });
}

function motionStoryMarkup(stage, result) {
  const fixed = stage === "after";
  return advancedStoryShell(`
    <div class="sample motion-sample">
      <p class="sample-label">Live updates</p><h1>Breaking news</h1>
      <div class="ticker"><span>Product launch</span><span>Market update</span><span>New release</span></div>
      <button>Pause animation</button>
      <div class="outcome"><span>After Pause</span><strong class="${fixed ? "good" : "bad"}">${fixed ? "Stable" : "Still moving"}</strong></div>
    </div>
    <div class="analysis">
      <span class="badge ${fixed ? "pass" : "fail"}">AEE · ${result.verdict.toUpperCase()}</span>
      <h2>${fixed ? "Motion stopped and stayed still" : "Pause control has no effect"}</h2>
      <div class="metric"><span>Active animations</span><strong>${result.settled.activeAnimations}</strong></div>
      <div class="metric"><span>Two samples stable</span><strong>${result.after.signature === result.settled.signature ? "Yes" : "No"}</strong></div>
      <p>AEE samples after the stop request twice, so a single frozen screenshot cannot create a false pass.</p>
    </div>`);
}

function advancedStoryShell(content) {
  return `<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;padding:20px;background:#07110e;color:#f5fbf8;font-family:Inter,ui-sans-serif,system-ui,sans-serif}
    #story-frame{display:grid;grid-template-columns:1.05fr .95fr;width:1080px;height:620px;overflow:hidden;border:1px solid #36584d;border-radius:18px;background:#0b1815}
    .sample{padding:46px;background:#f6f2e9;color:#1b2824}.palette-sample{background:#07110f;color:#f1f8f5}.palette-sample .sample-label{color:#91aaa2}.sample-label{margin:0;color:#66746f;font-weight:750;text-transform:uppercase;letter-spacing:.08em}.sample h1{margin:10px 0 8px;font-size:38px}.secondary{font-size:21px}
    .analysis{display:flex;flex-direction:column;justify-content:center;padding:42px}.analysis h2{margin:16px 0 12px;font-size:31px;line-height:1.12}.analysis p{color:#a9bbb4;font-size:17px;line-height:1.45}
    .badge{align-self:flex-start;padding:7px 10px;border-radius:999px;font-size:12px;font-weight:850;letter-spacing:.08em}.fail{background:#4a1515;color:#ff9999}.pass{background:#0b3a29;color:#70f0b4}
    .metric,.outcome{display:flex;justify-content:space-between;gap:20px;margin-top:10px;padding:12px 0;border-bottom:1px solid #345149}.sample .outcome{border-color:#d4cec2}.metric span,.outcome span{color:#98ada5}.sample .outcome span{color:#64706b}.good{color:#13734e}.bad{color:#a52222}
    .swatches{display:flex;gap:12px;margin-top:54px}.swatches i{width:62px;height:62px;border:3px solid white;border-radius:12px;box-shadow:0 2px 12px #0003}.chart{display:flex;align-items:end;gap:22px;height:190px;margin:18px 0}.chart i{display:block;width:72px;height:42%;border-radius:8px 8px 0 0;background:#7bcbaa}.chart i:nth-child(2){height:68%}.chart i:nth-child(3){height:88%;background:#167651;outline:5px solid #bcebd8}.chart i:nth-child(4){height:74%}
    .code{margin-top:22px;padding:18px;border:1px solid #345149;border-radius:10px;background:#06100d;color:#d6f6e8;font:700 15px/1.6 ui-monospace,monospace;white-space:pre}.ticker{display:flex;gap:14px;margin:48px -46px 28px;padding:20px;background:#142824;color:white;transform:translateX(18px)}.ticker span{flex:none;padding:10px 16px;border-radius:999px;background:#245245}.sample button{padding:12px 18px;border:0;border-radius:8px;background:#173f32;color:white;font:700 16px system-ui}
  </style></head><body><main id="story-frame">${content}</main></body></html>`;
}

async function generateHeadingStructureStory(activeBrowser) {
  const context = await activeBrowser.newContext({
    colorScheme: "dark",
    viewport: { width: 1120, height: 660 },
    deviceScaleFactor: 1
  });
  const headingOutput = path.join(outputRoot, "heading-structure");
  await mkdir(headingOutput, { recursive: true });

  try {
    const page = await context.newPage();
    await page.setContent(headingStoryMarkup("visual"));
    const axeResult = await new AxeBuilder({ page })
      .withRules(["heading-order", "page-has-heading-one", "empty-heading"])
      .analyze();

    if (axeResult.violations.length > 0) {
      throw new Error(
        `Expected the intentionally valid heading sequence to pass selected axe rules: ${axeResult.violations.map((violation) => violation.id).join(", ")}`
      );
    }

    await writeAxeArtifact("axe-heading-structure.json", axeResult, "./#examples");
    await page.locator("#story-frame").screenshot({
      path: path.join(headingOutput, "01-visual-page.png")
    });

    await page.setContent(headingStoryMarkup("axe"));
    await page.locator("#story-frame").screenshot({
      path: path.join(headingOutput, "02-axe-result.png")
    });

    const routing = routeContextualReview({
      kind: "heading-structure",
      hasFullPageContext: true,
      needsSemanticOutline: true
    });

    if (routing.route !== "ai-review") {
      throw new Error("Expected the full-page heading example to cross the AI review boundary.");
    }

    const suggestion = {
      safety: "review",
      summary: "Promote the visual Settings label to h2 and nest its three sections at h3.",
      rationale:
        "The full-page layout presents Settings as the parent of General, Members, and Danger zone. The existing DOM outline omits that relationship.",
      before: ["h1 Project Alpha", "h2 General", "h2 Members", "h2 Danger zone"],
      after: [
        "h1 Project Alpha",
        "  h2 Settings",
        "    h3 General",
        "    h3 Members",
        "    h3 Danger zone"
      ],
      verificationRequired: true
    };

    await writeFile(
      path.join(outputRoot, "ai-heading-suggestion.json"),
      `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          generation: {
            mode: "reviewed-demo-example",
            liveModelCall: false,
            note: "This checked-in contextual outline was authored with Codex and reviewed for the public demo. It is not an automated conformance verdict."
          },
          routing,
          context: {
            pageTitle: "Project Alpha",
            visualParent: "Settings",
            visualChildren: ["General", "Members", "Danger zone"],
            domOutline: suggestion.before
          },
          proposal: suggestion
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await page.setContent(headingStoryMarkup("aee"));
    await page.locator("#story-frame").screenshot({
      path: path.join(headingOutput, "03-aee-suggestion.png")
    });
  } finally {
    await context.close();
  }
}

function headingStoryMarkup(stage) {
  const stageContent = {
    visual: `
      <div class="callout amber">Visual relationship</div>
      <h2>“Settings” looks like the parent section</h2>
      <p class="explanation">The layout groups three subsections beneath it. That relationship should also exist in the heading outline.</p>`,
    axe: `
      <div class="callout green">axe-core · Pass</div>
      <h2>Selected automatic heading rules find no violation</h2>
      <div class="outline"><strong>DOM outline</strong><code>H1  Project Alpha</code><code>H2  General</code><code>H2  Members</code><code>H2  Danger zone</code></div>
      <p class="explanation">There is an H1, no heading is empty, and levels never skip. The visual parent is not encoded as a heading.</p>`,
    aee: `
      <div class="callout amber">AEE · Review required</div>
      <h2>Full-page context reveals the missing parent</h2>
      <div class="outline proposed"><strong>Proposed outline</strong><code>H1  Project Alpha</code><code>  H2  Settings</code><code>    H3  General</code><code>    H3  Members</code><code>    H3  Danger zone</code></div>
      <p class="explanation">AI proposes the semantic relationship; a person reviews it and a new scan verifies the accepted change.</p>`
  };

  return `<!doctype html>
    <html lang="en"><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 20px; background: #07110e; color: #f5fbf8; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      #story-frame { width: 1080px; height: 620px; display: grid; grid-template-columns: 1.08fr .92fr; gap: 20px; padding: 26px; border: 1px solid #29463d; border-radius: 20px; background: linear-gradient(145deg, #0d1d18, #09130f); }
      .browser { overflow: hidden; border: 1px solid #36584d; border-radius: 14px; background: #f6f2e9; color: #1b2824; }
      .chrome { display: flex; gap: 7px; height: 34px; padding: 13px; background: #d9d4ca; }
      .chrome i { width: 8px; height: 8px; border-radius: 50%; background: #8e8a82; }
      .page { padding: 26px; }
      .page h1 { margin: 0 0 8px; font-size: 30px; }
      .lede { margin: 0 0 24px; color: #65706b; }
      .visual-heading { position: relative; margin-bottom: 14px; padding: 13px 15px; border: 3px solid #d99017; border-radius: 10px; background: #fff9e8; font-size: 22px; font-weight: 800; }
      .visual-heading::after { content: "styled <div>, not a heading"; position: absolute; right: 10px; top: 12px; padding: 5px 8px; border-radius: 20px; background: #452e06; color: #ffe5a1; font-size: 11px; }
      .cards { display: grid; gap: 10px; }
      article { padding: 13px 15px; border: 1px solid #d6d1c7; border-radius: 10px; background: #fff; }
      article h2 { margin: 0 0 3px; font-size: 17px; }
      article p { margin: 0; color: #68736e; font-size: 13px; }
      .analysis { display: flex; flex-direction: column; justify-content: center; padding: 8px 12px; }
      .analysis h2 { margin: 16px 0 10px; font-size: 27px; line-height: 1.12; }
      .callout { align-self: flex-start; padding: 7px 10px; border-radius: 999px; font-size: 12px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
      .amber { background: #3b2c08; color: #ffd76a; }
      .green { background: #0b3a29; color: #70f0b4; }
      .explanation { color: #a9bbb4; line-height: 1.45; }
      .outline { display: grid; gap: 7px; margin: 6px 0 14px; padding: 15px; border: 1px solid #38584d; border-radius: 11px; background: #07110e; }
      .outline strong { margin-bottom: 4px; color: #8fa39b; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
      .outline code { color: #e9f5f0; font: 700 15px/1.2 ui-monospace, SFMono-Regular, monospace; white-space: pre; }
      .proposed { border-color: #97721e; background: #181505; }
    </style></head><body>
      <div id="story-frame">
        <div class="browser"><div class="chrome"><i></i><i></i><i></i></div><main class="page">
          <h1>Project Alpha</h1><p class="lede">Manage the people and configuration for this workspace.</p>
          <div class="visual-heading">Settings</div>
          <div class="cards">
            <article><h2>General</h2><p>Workspace name, description, and visibility</p></article>
            <article><h2>Members</h2><p>Roles, invitations, and access</p></article>
            <article><h2>Danger zone</h2><p>Archive or permanently delete this workspace</p></article>
          </div>
        </main></div>
        <section class="analysis">${stageContent[stage]}</section>
      </div>
    </body></html>`;
}

async function writeAxeArtifact(fileName, result, artifactUrl = "./demo-fixture.html") {
  await writeFile(
    path.join(outputRoot, fileName),
    `${JSON.stringify(
      {
        tool: {
          name: "axe-core",
          version: result.testEngine.version
        },
        url: artifactUrl,
        timestamp: result.timestamp,
        testEnvironment: result.testEnvironment,
        testRunner: result.testRunner,
        passes: result.passes,
        incomplete: result.incomplete,
        violations: result.violations
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function runEvidenceScenario(activeBrowser, options) {
  const context = await activeBrowser.newContext({
    colorScheme: "dark",
    viewport: { width: 1280, height: 720 }
  });

  try {
    const page = await context.newPage();
    await prepareRecordingPage(page, { label: "fixed", focus: options.focusImplementation });
    await page.getByRole("button", { name: "Delete Project Alpha" }).focus();

    return await runAeeOnPage({
      page,
      projectRoot,
      outputDir: "site/demo-artifacts",
      runId: options.runId,
      observers: ["dom", "focus", "visual"],
      judges: ["focus-management", "change-response", "release"],
      checkpointName: `public-demo-modal-focus-${options.focusImplementation}`,
      policy: {
        name: "public-demo",
        capture: {
          stabilizeAfterInteractionMs: 500
        }
      },
      interaction: {
        kind: "click",
        actor: "test",
        target: {
          role: "button",
          name: "Delete Project Alpha"
        },
        meta: {
          focusExpectation: "inside-dialog"
        }
      },
      async performInteraction({ page: activePage }) {
        await activePage.getByRole("button", { name: "Delete Project Alpha" }).click();
      }
    });
  } finally {
    await context.close();
  }
}

async function prepareRecordingPage(page, options) {
  const parameters = new URLSearchParams({
    label: options.label,
    focus: options.focus
  });
  await page.goto(`http://127.0.0.1:${port}/demo-fixture.html?${parameters}`, {
    waitUntil: "domcontentloaded"
  });
}

async function normalizeRunOutput(activeRunId, reporterFiles) {
  const runOutput = path.join(outputRoot, activeRunId);
  await normalizePublishedPaths([
    ...reporterFiles,
    path.join(runOutput, "bundle.json"),
    path.join(runOutput, "run.json")
  ]);
}

async function assertRunVerdicts(activeRunId, expectedVerdict) {
  const reportPath = path.join(outputRoot, activeRunId, "aee-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const verdicts = Object.fromEntries(
    report.judgments.map((judgment) => [judgment.judgeId, judgment.verdict])
  );

  if (
    report.run.status !== "completed" ||
    verdicts["focus-management"] !== expectedVerdict ||
    verdicts["change-response"] !== "pass" ||
    verdicts.release !== expectedVerdict
  ) {
    throw new Error(
      `Unexpected ${activeRunId} verdicts: expected ${expectedVerdict}, received ${JSON.stringify(verdicts)}`
    );
  }
}

async function normalizePublishedPaths(filePaths) {
  for (const filePath of filePaths) {
    const content = await readFile(filePath, "utf8");
    await writeFile(
      filePath,
      content.replaceAll(projectRoot, ".").replaceAll(`http://127.0.0.1:${port}/`, "./"),
      "utf8"
    );
  }
}
