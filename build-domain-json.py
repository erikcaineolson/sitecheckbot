#!/usr/bin/env python3
"""Helper to build domain JSON from arguments passed via stdin as JSON."""
import json, sys
from datetime import datetime, timezone

input_data = json.loads(sys.stdin.read())
domain = input_data["domain"]
url = input_data["url"]
pages = input_data.get("pages", [])
wcag = input_data.get("wcagIssues", [])
quality = input_data.get("qualityIssues", [])
broken = input_data.get("brokenLinks", [])
form_issues = input_data.get("formIssues", [])
ad_detection = input_data.get("adDetection", [])
crawl = input_data.get("crawlInfo", {})

if not ad_detection:
    ad_detection = [{"network": n, "detected": False, "foundOnPages": []} for n in [
        "Google AdSense","Google Ad Manager","Revive Ad Server","Amazon Ads",
        "Media.net","Taboola","Outbrain","Ezoic","Mediavine","AdThrive","Sovrn","PropellerAds"
    ]]

all_issues = wcag + quality + broken + form_issues
data = {
    "url": url,
    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    "crawlInfo": crawl or {"seedUrl": url, "pagesVisited": len(pages), "maxPages": 25, "totalLinksFound": 0, "totalLinksChecked": 0},
    "pages": pages,
    "summary": {
        "totalIssues": len(all_issues),
        "wcagIssues": len(wcag),
        "qualityIssues": len(quality),
        "brokenLinks": len(broken),
        "formIssues": len(form_issues),
        "criticalCount": sum(1 for i in all_issues if i.get("severity") == "critical") + len(broken),
        "warningCount": sum(1 for i in all_issues if i.get("severity") == "warning"),
        "infoCount": sum(1 for i in all_issues if i.get("severity") == "info"),
        "adNetworksDetected": [a["network"] for a in ad_detection if a.get("detected")]
    },
    "wcagIssues": wcag,
    "qualityIssues": quality,
    "brokenLinks": broken,
    "formIssues": form_issues,
    "adDetection": ad_detection
}

filename = f"sitecheck-{domain}-results.json"
with open(filename, "w") as f:
    json.dump(data, f, indent=2)
print(json.dumps({"file": filename, "summary": data["summary"]}))
