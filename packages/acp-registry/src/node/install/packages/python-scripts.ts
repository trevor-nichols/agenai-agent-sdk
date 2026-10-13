/** Only trusted stdlib metadata code executes during installation; package imports wait until launch. */
export const pythonMetadataScript = `import importlib.metadata, json, pathlib, sys
root = pathlib.Path(sys.argv[1])
items = []
for distribution in importlib.metadata.distributions(path=[str(root)]):
    items.append({"name": distribution.metadata["Name"], "version": distribution.version,
      "requires": distribution.requires or [],
      "files": [str(item) for item in distribution.files or []],
      "entryPoints": [{"name": item.name, "group": item.group, "value": item.value} for item in distribution.entry_points]})
print(json.dumps(items, sort_keys=True))
`;

export function pythonLaunchScript(module: string, attribute: string, command: string): string {
  return `import importlib, pathlib, sys\nsys.path.insert(0, str(pathlib.Path(__file__).resolve().parent / "site-packages"))\nsys.argv[0] = ${JSON.stringify(command)}\nentry = importlib.import_module(${JSON.stringify(module)})\nfor name in ${JSON.stringify(attribute.split('.'))}:\n    entry = getattr(entry, name)\nsys.exit(entry())\n`;
}
