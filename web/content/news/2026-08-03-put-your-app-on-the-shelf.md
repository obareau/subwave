---
title: Put your app on the shelf
date: 2026-08-03
category: Feature
author: The SUB/WAVE desk
excerpt: The new /apps page is a directory of players, bots, terminal clients and integrations built for SUB/WAVE stations. Browse what is there, or add yours with a short form.
---

A station serves a plain HTTP API from the same origin it streams from, so nobody is stuck with the player it ships with. People have been building their own for a while. Until now there was nowhere to find them.

## What's new

The [/apps](/apps) page lists what the community has built against a station. There are four to start.

One is a desk player that runs on a Raspberry Pi Pico 2 W, showing the current track on a small LCD with a physical skip button. A native desktop client covers macOS, Windows and Linux. A standalone MCP server lets you [drive the booth](/news/agent-in-the-booth) from any MCP client. The fourth is the reference web player, which exists to be forked and restyled.

The masthead has a new Community item as well, gathering [Skills](/skills), [Personas](/personas), [Shows](/shows) and Apps behind one heading.

## How to use it

Browse the directory at [/apps](/apps). The chips along the top filter by kind: mobile, web, desktop, terminal, bot, skin, integration.

If you built something, hit "Submit an app". That opens a GitHub issue form, so there is no fork and no JSON to write. Name, link and kind are the only fields you have to fill in. A bot turns your issue into a pull request, and once a maintainer merges it your app shows up on the next deploy. Edit the issue afterwards and the pull request follows.

Icons and screenshots are optional, and have to be hosted on GitHub. Commit the image to your own repo and paste the raw link. That way the site proxies the image instead of sending a reader's browser off to an arbitrary host.

## Why it helps

The API has always been open. What was missing was a way to find out what anyone had done with it. A listener who wants a menu-bar player or a Pi on the desk can now go and get one, and someone who spent a weekend building something has somewhere to put it.

These are built and maintained by their authors, not by us. A listing is not a review. No app should ever ask you for your station's admin password, and there is a report link on the page if one does.
