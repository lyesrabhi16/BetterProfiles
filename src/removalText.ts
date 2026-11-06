// What is said when an extension is not uninstalled although it was asked for, and why. Pure, no `vscode` import.

/** Why an extension is never uninstalled from just one profile. */
export type KeptReason = 'application' | 'self' | 'keep' | 'everywhere';

const names = (ids: string[]) => ids.join(', ');

/** Full sentences for a notification: each reason once, naming only the extensions it applies to. */
export function keptSentence(reasons: Record<string, KeptReason>): string {
	const of = (reason: KeptReason) => Object.keys(reasons).filter(id => reasons[id] === reason);
	const sentences: string[] = [];
	const application = of('application');
	if (application.length > 0) {
		const them = application.length === 1 ? 'it' : 'them';
		sentences.push(`Kept ${names(application)}: VS Code applies ${them} to all profiles, so removing ${them} here would remove ${them} from every profile. To remove ${them} from just this profile, turn off "Apply Extension to all Profiles" for ${them} in the Extensions view first.`);
	}
	const self = of('self');
	if (self.length > 0) {
		sentences.push(`Kept ${names(self)}: it is this extension.`);
	}
	const keep = of('keep');
	if (keep.length > 0) {
		sentences.push(`Kept ${names(keep)}: ${keep.length === 1 ? 'it is' : 'they are'} listed in the betterProfiles.keepExtensions setting.`);
	}
	const everywhere = of('everywhere');
	if (everywhere.length > 0) {
		const them = everywhere.length === 1 ? 'it' : 'them';
		sentences.push(`Kept ${names(everywhere)}: ${everywhere.length === 1 ? 'it is' : 'they are'} installed in every profile, which is how VS Code stores an extension applied to all profiles, so removing ${them} here would remove ${them} from every profile.`);
	}
	return sentences.join(' ');
}

const SHORT: Record<KeptReason, string> = {
	application: 'applied to all profiles',
	self: 'this extension',
	keep: 'in keepExtensions',
	everywhere: 'installed in every profile',
};

/** One line for a question: each extension that stays, with its reason in a few words. */
export function keptDetail(reasons: Record<string, KeptReason>): string {
	return Object.keys(reasons).map(id => `${id} (${SHORT[reasons[id]]})`).join(', ');
}
