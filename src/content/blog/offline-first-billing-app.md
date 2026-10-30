---
title: 'Bill Studio: an offline billing app'
description: 'Notes on Bill Studio: a free, offline, multi-country billing PWA where all data stays on your device.'
pubDate: 2026-10-20
tags: ['PWA', 'JavaScript', 'Privacy']
---

[Bill Studio](/projects/bill-studio/) is a free billing app that runs entirely in the browser: no sign-up, no server and no internet needed after the first visit. It's a static web app plus a browser database. Here is how it fits together.

## Every country is data

Tax rules differ a lot. India has CGST, SGST, IGST and UTGST splits, cess and HSN codes. The EU and UK have VAT, the US has sales tax, Canada has GST, HST, PST and QST. Hard-coding each into the UI would never finish, so the app picks a country and loads its tax system, currency, bill titles and financial year as configuration. There is a generic mode for anywhere else.

## Offline means local-first

- **Storage:** everything lives in the browser's IndexedDB on the device.
- **Install:** it's a PWA with a service worker, so it works with no connection after the first visit.
- **One file:** a build script produces a single HTML file that runs by double-clicking it, plus a zip you can host on any intranet server.

## Privacy without a backend

No server means there's nothing to breach, but the device can still be lost. So the owner sign-in password is stored as a salted PBKDF2-SHA-256 hash, the app locks itself after inactivity, and backups can be encrypted with AES-GCM using the browser's Web Crypto API. Moving data between devices is an explicit export and import.

## Printing is the real feature

A bill that can't print properly isn't a bill. The print dialog covers A4, Letter, Legal, half and quarter pages, 58 mm and 80 mm thermal rolls, and several bills per sheet with cut lines, plus original, duplicate and triplicate copies. A drag-and-drop designer lets you move and restyle every block, with snapping guides and undo.

## What I'd tell myself at the start

1. Treat jurisdiction rules as data from day one.
2. Decide the backup story before the first feature.
3. Test printing on real paper early.

[Try it](/projects/bill-studio/) or read the [source](https://github.com/ramlakhanmadheshiya/bill-studio).
