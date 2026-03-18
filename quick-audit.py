#!/usr/bin/env python3
"""Quick audit JSON builder for domains with common GHL pattern."""
import json, sys
from datetime import datetime, timezone

args = json.loads(sys.stdin.read())
domain = args["domain"]
sanitized = args["sanitized"]
url = args["url"]
pages = args.get("pages", [{"url": url + "/", "status": "ok"}])
wcag = args.get("wcag", [])
quality = args.get("quality", [])
broken = args.get("broken", [])
forms_missing = args.get("formsMissing", 0)
has_blog_404 = args.get("blog404", None)
missing_desc = args.get("missingDesc", True)
extra_contrast = args.get("contrastIssues", [])

# Add blog 404 page and broken link
if has_blog_404:
    pages.append({"url": has_blog_404, "status": "error", "error": "404 Not Found"})
    broken.append({"url": has_blog_404, "status": 404, "error": "", "linkText": "Blog/Content link", "internal": True, "foundOnPages": [url + "/"]})

# Add contrast issues
for ci in extra_contrast:
    wcag.append({
        "pageUrl": url + "/", "criterion": "1.4.3", "name": "Contrast (Minimum)", "level": "AA",
        "severity": ci.get("severity", "critical"), "element": ci["element"],
        "description": ci["description"], "currentValue": ci.get("ratio", ""), "requiredValue": ci.get("required", "4.5:1"),
        "sourceFile": "embedded <style>", "existingRule": "", "cssBefore": ci.get("before", ""),
        "cssAfter": ci.get("after", ""), "cssFix": ci.get("fix", ""),
        "reference": "https://www.w3.org/TR/WCAG21/#contrast-minimum"
    })

# Add missing form labels
for i in range(forms_missing):
    quality.append({
        "pageUrl": url + "/", "category": "Missing Label", "severity": "critical",
        "element": f"form input #{i+1}", "description": f"Form field #{i+1} has no label or aria-label",
        "sourceFile": "n/a", "existingRule": "", "cssBefore": "(not set)",
        "cssAfter": "(not applicable)", "cssFix": "", "recommendation": "Add aria-label attribute"
    })

# Add missing description
if missing_desc:
    quality.append({
        "pageUrl": url + "/", "category": "Missing Title", "severity": "info",
        "element": "meta[name='description']", "description": "Page has an empty meta description",
        "sourceFile": "n/a", "existingRule": "", "cssBefore": "(not set)",
        "cssAfter": "(not applicable)", "cssFix": "", "recommendation": "Add a meaningful meta description"
    })

all_issues = wcag + quality + broken
ad = [{"network": n, "detected": False, "foundOnPages": []} for n in [
    "Google AdSense","Google Ad Manager","Revive Ad Server","Amazon Ads",
    "Media.net","Taboola","Outbrain","Ezoic","Mediavine","AdThrive","Sovrn","PropellerAds"]]

data = {
    "url": url, "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
    "crawlInfo": {"seedUrl": url, "pagesVisited": len(pages), "maxPages": 25,
        "totalLinksFound": args.get("linkCount", 0), "totalLinksChecked": len(pages)},
    "pages": pages,
    "summary": {"totalIssues": len(all_issues), "wcagIssues": len(wcag), "qualityIssues": len(quality),
        "brokenLinks": len(broken), "formIssues": 0,
        "criticalCount": sum(1 for i in all_issues if i.get("severity") == "critical") + len(broken),
        "warningCount": sum(1 for i in all_issues if i.get("severity") == "warning"),
        "infoCount": sum(1 for i in all_issues if i.get("severity") == "info"),
        "adNetworksDetected": []},
    "wcagIssues": wcag, "qualityIssues": quality, "brokenLinks": broken,
    "formIssues": [], "adDetection": ad
}

filename = f"sitecheck-{sanitized}-results.json"
with open(filename, "w") as f:
    json.dump(data, f, indent=2)
print(json.dumps({"file": filename, "summary": data["summary"]}))
