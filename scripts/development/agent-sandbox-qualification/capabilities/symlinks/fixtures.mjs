export const binary = Buffer.from([0, 255, 17, 128, 10, 0, 1]);
export const executable = Buffer.from('#!/bin/sh\nexit 0\n');
export const unicode = 'é'.repeat(80);
export const links = Object.freeze([
  ['root-link', 'data/blob.bin'], ['data/self', './blob.bin'], ['data/parent', '../scripts/run.sh'],
  ['chain', 'root-link'], ['dangling', 'data/missing'], ['cycle-a', 'cycle-b'], ['cycle-b', 'cycle-a'],
  [`${unicode}/shortcut`, '../data/blob.bin'], ['raw-slashes', 'data//./blob.bin'],
].map(Object.freeze));
