import { Octokit } from "@octokit/rest";
import slugify from "@sindresorhus/slugify";
import { readFile, writeFile } from "fs-extra";
import { safeLoad } from "js-yaml";
import { join } from "path";
import { format } from "prettier";
import { commit, push } from "./git";
import { UpptimeConfig } from "./interfaces";

export const generateSummary = async () => {
  const config = safeLoad(await readFile(join(".", ".upptimerc.yml"), "utf8")) as UpptimeConfig;
  const owner = config.owner;
  const repo = config.repo;

  const octokit = new Octokit({
    auth: config.PAT || process.env.GH_PAT || process.env.GITHUB_TOKEN,
    userAgent: config["user-agent"] || process.env.USER_AGENT || "KojBot",
  });

  let readmeContent = await readFile(join(".", "README.md"), "utf8");

  const startText = readmeContent.split("<!--start: status pages-->")[0];
  const endText = readmeContent.split("<!--end: status pages-->")[1];

  const pageStatuses: Array<{
    url: string;
    status: string;
    slug: string;
    time: number;
    uptime: string;
    name: string;
  }> = [];

  let numberOfDown = 0;
  for await (const site of config.sites) {
    const slug = slugify(site.name);
    let startTime = new Date().toISOString();
    try {
      startTime =
        (
          (await readFile(join(".", "history", `${slug}.yml`), "utf8"))
            .split("\n")
            .find((line) => line.toLocaleLowerCase().includes("- starttime")) || ""
        )
          .split("startTime:")[1]
          .trim() || new Date().toISOString();
    } catch (error) {}
    let secondsDown = 0;
    const history = await octokit.repos.listCommits({
      owner,
      repo,
      path: `history/${slug}.yml`,
      per_page: 100,
    });
    const issues = await octokit.issues.listForRepo({
      owner,
      repo,
      labels: slug,
      filter: "all",
      per_page: 100,
    });
    issues.data.forEach((issue) => {
      if (issue.closed_at)
        secondsDown += Math.floor(
          (new Date(issue.closed_at).getTime() - new Date(issue.created_at).getTime()) / 1000
        );
      else
        secondsDown += Math.floor(
          (new Date().getTime() - new Date(issue.created_at).getTime()) / 1000
        );
    });
    const uptime = (
      100 -
      100 * (secondsDown / ((new Date().getTime() - new Date(startTime).getTime()) / 1000))
    ).toFixed(2);
    if (!history.data.length) continue;
    const averageTime =
      history.data
        .filter(
          (item) =>
            item.commit.message.includes(" in ") &&
            Number(item.commit.message.split(" in ")[1].split("ms")[0]) !== 0 &&
            !isNaN(Number(item.commit.message.split(" in ")[1].split("ms")[0]))
        )
        .map((item) => Number(item.commit.message.split(" in ")[1].split("ms")[0]))
        .reduce((p, c) => p + c, 0) / history.data.length;
    const status = history.data[0].commit.message.split(" ")[0].includes("🟩") ? "up" : "down";
    pageStatuses.push({
      name: site.name,
      url: site.url,
      slug,
      status,
      uptime,
      time: Math.floor(averageTime),
    });
    if (status === "down") {
      numberOfDown++;
    }
  }

  if (readmeContent.includes("<!--start: status pages-->")) {
    readmeContent = `${startText}<!--start: status pages-->
| URL | Status | History | Response Time | Uptime |
| --- | ------ | ------- | ------------- | ------ |
${pageStatuses
  .map(
    (page) =>
      `| ${page.url.startsWith("$") ? page.name : `[${page.name}](${page.url})`} | ${
        page.status === "up" ? "🟩 Up" : "🟥 Down"
      } | [${page.slug}.yml](https://github.com/${owner}/${repo}/commits/master/history/${
        page.slug
      }.yml) | <img alt="Response time graph" src="./graphs/${page.slug}.png" height="20"> ${
        page.time
      }ms | ![Uptime ${
        page.uptime
      }%](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2F${owner}%2F${repo}%2Fmaster%2Fapi%2F${
        page.slug
      }%2Fuptime.json)`
  )
  .join("\n")}
<!--end: status pages-->${endText}`;
  }

  if (owner !== "upptime" && repo !== "upptime") {
    let website = `https://${config.owner}.github.io/${config.repo}/`;
    if (config["status-website"] && config["status-website"].cname)
      website = `https://${config["status-website"].cname}`;

    // Remove Upptime logo and add heaading
    readmeContent = readmeContent
      .split("\n")
      .map((line, index) => {
        if (index === 0 && line.includes("https://upptime.js.org"))
          return `# [📈 Live Status](${website}): <!--live status--> **🟩 All systems operational**`;
        if (
          line.includes("[![Summary CI](https://github.com") &&
          readmeContent.includes("<!--start: description-->")
        )
          return `${line}\n\nWith [Upptime](https://upptime.js.org), you can get your own unlimited and free uptime monitor and status page, powered entirely by a GitHub repository. We use [Issues](https://github.com/${config.owner}/${config.repo}/issues) as incident reports, [Actions](https://github.com/${config.owner}/${config.repo}/actions) as uptime monitors, and [Pages](${website}) for the status page.`;
        return line;
      })
      .filter((line) => !line.startsWith("## [📈 Live Status]"))
      .join("\n");

    // Remove default documentation
    const docsStartText = readmeContent.split("<!--start: docs-->")[0];
    const docsEndText = readmeContent.split("<!--end: docs-->")[1];
    if (readmeContent.includes("<!--start: docs-->"))
      readmeContent = `${docsStartText}[**Visit our status website →**](${website})${docsEndText}`;

    // Remove Koj logo
    const logoStartText = readmeContent.split("<!--start: logo-->")[0];
    const logoEndText = readmeContent.split("<!--end: logo-->")[1];
    if (readmeContent.includes("<!--start: logo-->"))
      readmeContent = `${logoStartText}${logoEndText}`;

    let name = `[${config.owner}](${website})`;
    if (
      readmeContent.includes("[MIT](./LICENSE) © [Koj](https://koj.co)") ||
      readmeContent.includes("<!--start: description-->")
    ) {
      try {
        const org = await octokit.users.getByUsername({ username: config.owner });
        name = `[${org.data.name || config.owner}](${org.data.blog || website})`;
      } catch (error) {}

      // Remove Koj description
      const descriptionStartText = readmeContent.split("<!--start: description-->")[0];
      const descriptionEndText = readmeContent.split("<!--end: description-->")[1];
      if (readmeContent.includes("<!--start: description-->"))
        readmeContent = `${descriptionStartText}This repository contains the open-source uptime monitor and status page for ${name}, powered by [Upptime](https://github.com/upptime/upptime).${descriptionEndText}`;

      // Change copyright
      readmeContent = readmeContent.replace(
        "[MIT](./LICENSE) © [Koj](https://koj.co)",
        `[MIT](./LICENSE) © ${name}`
      );
    }

    // Change badges
    readmeContent = readmeContent.replace(
      new RegExp("upptime/upptime/workflows", "g"),
      `${config.owner}/${config.repo}/workflows`
    );

    // Add repo description, topics, etc.
    try {
      const repoInfo = await octokit.repos.get({ owner, repo });
      if (!repoInfo.data.description && !config.skipDescriptionUpdate)
        await octokit.repos.update({
          owner,
          repo,
          description: `📈 Uptime monitor and status page for ${name
            .split("]")[0]
            .replace("[", "")}, powered by @upptime`,
        });
      if (!repoInfo.data.topics.length && !config.skipTopicsUpdate)
        await octokit.repos.replaceAllTopics({
          owner,
          repo,
          names: ["uptime-monitor", "status-page", "upptime"],
        });
      if (!repoInfo.data.homepage && !config.skipHomepageUpdate)
        await octokit.repos.update({
          owner,
          repo,
          homepage: website,
        });
    } catch (error) {}
  }

  // Add live status line
  readmeContent = readmeContent
    .split("\n")
    .map((line) => {
      if (line.includes("<!--live status-->")) {
        line = `${line.split("<!--live status-->")[0]}<!--live status--> **${
          numberOfDown === 0
            ? "🟩 All systems operational"
            : numberOfDown === config.sites.length
            ? "🟥 Complete outage"
            : "🟨 Partial outage"
        }**`;
      }
      return line;
    })
    .join("\n");

  await writeFile(join(".", "README.md"), format(readmeContent));
  commit(
    (config.commitMessages || {}).readmeContent ||
      ":pencil: Update summary in README [skip ci] [upptime]",
    (config.commitMessages || {}).commitAuthorName,
    (config.commitMessages || {}).commitAuthorEmail
  );

  await writeFile(join(".", "history", "summary.json"), JSON.stringify(pageStatuses, null, 2));
  commit(
    (config.commitMessages || {}).summaryJson ||
      ":card_file_box: Update status summary [skip ci] [upptime]",
    (config.commitMessages || {}).commitAuthorName,
    (config.commitMessages || {}).commitAuthorEmail
  );

  push();
};
