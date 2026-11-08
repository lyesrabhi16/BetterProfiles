// Builds a tiny, valid .vsix (a zip) for the end-to-end tests, without vsce and without the network: the tests need a few
// extensions with known ids, some of which depend on others, to install with the real command line.

import * as zlib from 'zlib';

export interface FixtureExtension {
	publisher: string;
	name: string;
	version: string;
	displayName?: string;
	/** Ids (publisher.name) of the extensions this one needs: VS Code then refuses to uninstall those while this is there. */
	dependencies?: string[];
	/** A PNG to use as the extension's icon. */
	icon?: Buffer;
}

const TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
})();

export function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Entry {
	name: string;
	data: Buffer;
}

/** A zip: each file deflated, then the central directory at the end. Dates are fixed so that the same input gives the same bytes. */
function zip(entries: Entry[]): Buffer {
	const DOS_TIME = 0;
	const DOS_DATE = (1 << 5) | 1; // 1980-01-01
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const { name, data } of entries) {
		const nameBytes = Buffer.from(name, 'utf8');
		const packed = zlib.deflateRawSync(data);
		const useDeflate = packed.length < data.length;
		const body = useDeflate ? packed : data;
		const method = useDeflate ? 8 : 0;
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6); // names are UTF-8
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(DOS_TIME, 10);
		local.writeUInt16LE(DOS_DATE, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		parts.push(local, nameBytes, body);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt16LE(0x0800, 8);
		entry.writeUInt16LE(method, 10);
		entry.writeUInt16LE(DOS_TIME, 12);
		entry.writeUInt16LE(DOS_DATE, 14);
		entry.writeUInt32LE(crc, 16);
		entry.writeUInt32LE(body.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(nameBytes.length, 28);
		entry.writeUInt32LE(offset, 42);
		central.push(entry, nameBytes);
		offset += local.length + nameBytes.length + body.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, end]);
}

const NAME = /^[a-z0-9][a-z0-9-]*$/i;

export function buildVsix(extension: FixtureExtension): Buffer {
	const { publisher, name, version } = extension;
	if (!NAME.test(publisher) || !NAME.test(name) || !/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error(`invalid fixture extension ${publisher}.${name}@${version}`);
	}
	const dependencies = extension.dependencies ?? [];
	const displayName = extension.displayName ?? name;
	const manifest = {
		name,
		displayName,
		publisher,
		version,
		description: `Fixture ${publisher}.${name} for the end-to-end tests`,
		engines: { vscode: '^1.60.0' },
		main: './extension.js',
		activationEvents: [], // it is never started
		...(dependencies.length > 0 ? { extensionDependencies: dependencies } : {}),
		...(extension.icon ? { icon: 'icon.png' } : {}),
	};
	const properties = [
		['Microsoft.VisualStudio.Code.Engine', '^1.60.0'],
		['Microsoft.VisualStudio.Code.ExtensionDependencies', dependencies.join(',')],
		['Microsoft.VisualStudio.Code.ExtensionPack', ''],
		['Microsoft.VisualStudio.Code.ExtensionKind', 'workspace'],
		['Microsoft.VisualStudio.Code.LocalizedLanguages', ''],
		['Microsoft.VisualStudio.Code.EnabledApiProposals', ''],
		['Microsoft.VisualStudio.Code.ExecutesCode', 'true'],
	].map(([id, value]) => `<Property Id="${id}" Value="${escapeXml(value)}" />`).join('\n\t\t\t\t');
	const vsixmanifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
	<Metadata>
		<Identity Language="en-US" Id="${escapeXml(name)}" Version="${version}" Publisher="${escapeXml(publisher)}" />
		<DisplayName>${escapeXml(displayName)}</DisplayName>
		<Description xml:space="preserve">${escapeXml(manifest.description)}</Description>
		<Tags></Tags>
		<Categories></Categories>
		<GalleryFlags>Public</GalleryFlags>
		<Properties>
			${properties}
		</Properties>
	</Metadata>
	<Installation>
		<InstallationTarget Id="Microsoft.VisualStudio.Code"/>
	</Installation>
	<Dependencies/>
	<Assets>
		<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
		<Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />${extension.icon ? '\n\t\t<Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.png" Addressable="true" />' : ''}
	</Assets>
</PackageManifest>
`;
	const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".js" ContentType="application/javascript"/><Default Extension=".json" ContentType="application/json"/><Default Extension=".md" ContentType="text/markdown"/><Default Extension=".png" ContentType="image/png"/><Default Extension=".vsixmanifest" ContentType="text/xml"/></Types>`;
	return zip([
		{ name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
		{ name: 'extension.vsixmanifest', data: Buffer.from(vsixmanifest) },
		{ name: 'extension/package.json', data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n') },
		{ name: 'extension/extension.js', data: Buffer.from(`// ${publisher}.${name}: a fixture, never activated\n`) },
		{ name: 'extension/README.md', data: Buffer.from(`# ${displayName}\n`) },
		...(extension.icon ? [{ name: 'extension/icon.png', data: extension.icon }] : []),
	]);
}
