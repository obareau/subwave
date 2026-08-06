---
title: The all-in-one image can use your GPU now
date: 2026-07-26
category: Feature
author: The SUB/WAVE desk
excerpt: A new subwave-aio-cuda image runs the sounds-like and vocal analysis on an NVIDIA card, so one-click installs get the fast path without splitting into a five-service stack.
---

When [the CUDA analyzer shipped last week](/news/analyzer-on-the-gpu), it only helped one kind of install. The overlay it rides on swaps a container inside the full compose stack, and the [one-click image](/news/one-click-on-unraid) has none to swap. So an operator running the all-in-one asked the obvious question. What about the rest of us?

## What's new

There is a third flavour of the one-click image, `subwave-aio-cuda`. Same whole station in one container, same heavy analysis as `subwave-aio-heavy`, except CLAP and Demucs run on your NVIDIA card instead of your cores.

No overlay this time. There is nothing to layer a second compose file over, so the GPU rides on the image itself.

## Switching on Unraid

Install the Nvidia Driver plugin from Apps first, then note your card's UUID under Settings, Nvidia Driver.

Now open the Docker tab, click the subwave container, hit Edit, and turn on Advanced View. Four fields:

- Repository becomes `ghcr.io/perminder-klair/subwave-aio-cuda:latest`
- Extra Parameters gets `--runtime=nvidia` appended, keeping the `--add-host` value already there
- `NVIDIA_VISIBLE_DEVICES` takes your card's UUID, or `all`
- `NVIDIA_DRIVER_CAPABILITIES` takes `compute,utility`

Apply, and Unraid re-pulls. Anywhere else, it is `--gpus all` on your `docker run`.

Your appdata volume is untouched, so settings, personas, library tags and the cached model weights all survive. Point the Repository field back at `subwave-aio` whenever you want to undo it.

## Worth knowing

The image is around 4 GB compressed, against the heavy image's 1.3 GB, because the CUDA runtime ships inside it. The host still needs nothing but the driver plugin.

If the card ends up invisible, the analyzer says so in the log and carries on using the CPU. A half-finished setup runs slow, not broken.

One trap to avoid. Do not point an all-in-one container at `subwave-analyzer-cuda`. That is the bare analyzer service, and swapping to it replaces your entire station with just an analyzer.

## Why it helps

A one-click install was always a trade, less to configure in exchange for less to tune. This takes one thing off that list. If there is a card in the box, the [deep analysis](/manual/analysis) can use it, no five-service stack required.
