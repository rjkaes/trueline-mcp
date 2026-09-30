import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { handleOutline } from "../../src/tools/outline.ts";
import { extractXmlOutline } from "../../src/outline/xml.ts";
import { getText, writeTestFile as _writeTestFile } from "../helpers.ts";

let testDir: string;
const writeTestFile = (name: string, content: string) => _writeTestFile(testDir, name, content);

beforeAll(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), "trueline-outline-xml-test-")));
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("XML outline", () => {
  test("extracts nested elements with depth", async () => {
    const file = writeTestFile(
      "basic.xml",
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<project>",
        "  <dependencies>",
        "    <dependency>",
        "      <groupId>org.example</groupId>",
        "      <artifactId>lib</artifactId>",
        "    </dependency>",
        "  </dependencies>",
        "</project>",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(result.isError).toBeUndefined();
    const text = getText(result);

    expect(text).toContain("<?xml");
    expect(text).toContain("<project>");
    expect(text).toContain("<dependencies>");
    expect(text).toContain("<dependency>");
  });

  test("self-closing elements", async () => {
    const file = writeTestFile(
      "selfclose.xml",
      [
        "<config>",
        '  <setting name="debug" value="true" />',
        '  <setting name="port" value="8080" />',
        "</config>",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    expect(text).toContain("<config>");
    expect(text).toContain('name="debug"');
    expect(text).toContain('name="port"');
  });

  test("skips comments", async () => {
    const file = writeTestFile(
      "comments.xml",
      ["<root>", "  <!-- This is a comment with <fake> tags -->", "  <real>content</real>", "</root>", ""].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    expect(text).toContain("<root>");
    expect(text).toContain("<real>");
    expect(text).not.toContain("fake");
    expect(text).not.toContain("comment");
  });

  test("skips CDATA sections", async () => {
    const file = writeTestFile(
      "cdata.xml",
      ["<root>", "  <code><![CDATA[", "    <not-a-tag>", "  ]]></code>", "</root>", ""].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    expect(text).toContain("<root>");
    expect(text).toContain("<code>");
    expect(text).not.toContain("not-a-tag");
  });

  test("handles processing instructions", async () => {
    const file = writeTestFile(
      "pi.xml",
      ['<?xml version="1.0"?>', '<?xml-stylesheet type="text/xsl" href="style.xsl"?>', "<root />", ""].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    expect(text).toContain("<?xml version");
    expect(text).toContain("<?xml-stylesheet");
    expect(text).toContain("<root />");
  });

  test("self-closing tag at root level", async () => {
    const file = writeTestFile("selfclose-root.xml", "<root />\n");

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);
    expect(text).toContain("<root />");
  });

  test("depth limiting", async () => {
    const file = writeTestFile(
      "deep.xml",
      [
        "<a>",
        "  <b>",
        "    <c>",
        "      <d>",
        "        <e>leaf</e>",
        "      </d>",
        "    </c>",
        "  </b>",
        "</a>",
        "",
      ].join("\n"),
    );

    const shallow = await handleOutline({ file_paths: [file], depth: 1, projectDir: testDir });
    const shallowText = getText(shallow);

    // depth 0 = <a>, depth 1 = <b>
    expect(shallowText).toContain("<a>");
    expect(shallowText).toContain("<b>");
    expect(shallowText).not.toContain("<c>");
    expect(shallowText).not.toContain("<d>");
    expect(shallowText).not.toContain("<e>");
  });

  test("multi-line opening tag", async () => {
    const file = writeTestFile(
      "multiline-tag.xml",
      [
        "<widget",
        '  id="main"',
        '  class="container"',
        '  style="display:block">',
        "  <child />",
        "</widget>",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    // Signature should include attributes from the multi-line tag
    expect(text).toContain('id="main"');
    expect(text).toContain("<child />");
  });

  test("handles DOCTYPE declarations", async () => {
    const file = writeTestFile(
      "doctype.xml",
      [
        '<?xml version="1.0"?>',
        '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">',
        "<html>",
        "  <body />",
        "</html>",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    // DOCTYPE should be skipped, not produce outline entries or break parsing
    expect(text).toContain("<html>");
    expect(text).toContain("<body />");
    expect(text).not.toContain("DOCTYPE");
  });

  test("skips DOCTYPE internal subset declarations", async () => {
    const file = writeTestFile(
      "doctype-subset.xml",
      [
        '<?xml version="1.0"?>',
        "<!DOCTYPE note [",
        "  <!ELEMENT note (to,body)>",
        "  <!ATTLIST note id CDATA #REQUIRED>",
        '  <!ENTITY writer "Jane">',
        "]>",
        '<note id="1">',
        "  <to>Tove</to>",
        "  <body>&writer;</body>",
        "</note>",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    // Markup declarations inside [...] end with '>' but must not end the DOCTYPE
    expect(text).not.toContain("<!ATTLIST");
    expect(text).not.toContain("<!ENTITY");
    expect(text).toMatch(/^7-10: <note id="1">/m);
    expect(text).toMatch(/^ {2}8-8: <to>/m);
  });

  test("reports correct line numbers", async () => {
    const file = writeTestFile(
      "lines.xml",
      [
        "<root>", // line 1
        "  <first />", // line 2
        "  <second>", // line 3
        "    <nested />", // line 4
        "  </second>", // line 5
        "</root>", // line 6
        "", // line 7
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    // root spans 1-6, first is 2-2, second spans 3-5
    expect(text).toMatch(/1-6:.*<root>/);
    expect(text).toMatch(/2-2:.*<first \/>/);
    expect(text).toMatch(/3-5:.*<second>/);
  });

  test("empty XML file", async () => {
    const file = writeTestFile("empty.xml", "");

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("no outline entries");
  });

  test("SVG file extension is supported", async () => {
    const file = writeTestFile(
      "icon.svg",
      [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
        '  <circle cx="50" cy="50" r="40" />',
        '  <rect x="10" y="10" width="80" height="80" />',
        "</svg>",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    expect(text).toContain("<svg");
    expect(text).toContain("<circle");
    expect(text).toContain("<rect");
  });

  test("XHTML file extension is supported", async () => {
    const file = writeTestFile("page.xhtml", "<html><head><title /></head><body><p /></body></html>\n");

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("<html>");
  });

  test("multi-line comment does not produce entries", async () => {
    const file = writeTestFile(
      "multiline-comment.xml",
      [
        "<root>",
        "  <!--",
        "    This is a multi-line comment",
        "    with <fake> tags inside",
        "  -->",
        "  <real />",
        "</root>",
        "",
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    expect(text).toContain("<root>");
    expect(text).toContain("<real />");
    expect(text).not.toContain("fake");
  });

  test("unclosed elements get entries ending at EOF", async () => {
    const file = writeTestFile(
      "unclosed.xml",
      [
        "<root>",
        "  <unclosed>",
        "    <leaf />",
        // intentionally no closing tags
      ].join("\n"),
    );

    const result = await handleOutline({ file_paths: [file], projectDir: testDir });
    const text = getText(result);

    expect(text).toContain("<root>");
    expect(text).toContain("<unclosed>");
    expect(text).toContain("<leaf />");
  });
});

async function outline(name: string, source: string): Promise<{ text: string; isError: boolean }> {
  const file = writeTestFile(name, source);
  const result = await handleOutline({ file_paths: [file], projectDir: testDir });
  return { text: getText(result), isError: result.isError === true };
}

describe("XML tag parsing and project file types", () => {
  test("a '>' inside an attribute value does not end the tag", async () => {
    const file = writeTestFile(
      "template.xsl",
      ["<stylesheet>", '  <xsl:if test="count(item) > 1"/>', "  <xsl:apply-templates/>", "</stylesheet>", ""].join(
        "\n",
      ),
    );

    const { entries } = await extractXmlOutline(file);

    expect(entries.map((e) => `${e.depth}:${e.text}`)).toEqual([
      "0:<stylesheet>",
      '1:<xsl:if test="count(item) > 1" />',
      "1:<xsl:apply-templates />",
    ]);
  });

  test("an unclosed element is kept when its parent closes", async () => {
    const file = writeTestFile("unclosed.xml", ["<root>", "  <a>", "    <b>text", "  </a>", "</root>", ""].join("\n"));

    const { entries } = await extractXmlOutline(file);

    expect(entries.map((e) => e.text)).toContain("<b>");
  });

  test(".fsproj project files are outlined like .csproj", async () => {
    const { text } = await outline(
      "App.fsproj",
      ["<Project>", "  <PropertyGroup>", "  </PropertyGroup>", "</Project>", ""].join("\n"),
    );

    expect(text).not.toContain("No outline support");
  });
});
