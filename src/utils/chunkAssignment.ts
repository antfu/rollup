import prettyBytes from 'pretty-bytes';
import ExternalModule from '../ExternalModule';
import Module from '../Module';
import { getOrCreate } from './getOrCreate';
import { concatLazy } from './iterators';
import { timeEnd, timeStart } from './timers';

type DependentModuleMap = Map<Module, Set<Module>>;
type ReadonlyDependentModuleMap = ReadonlyMap<Module, ReadonlySet<Module>>;
type ChunkDefinitions = { alias: string | null; modules: Module[] }[];

export function getChunkAssignments(
	entries: readonly Module[],
	manualChunkAliasByEntry: ReadonlyMap<Module, string>,
	minChunkSize: number
): ChunkDefinitions {
	const chunkDefinitions: ChunkDefinitions = [];
	const modulesInManualChunks = new Set(manualChunkAliasByEntry.keys());
	const manualChunkModulesByAlias: Record<string, Module[]> = Object.create(null);
	for (const [entry, alias] of manualChunkAliasByEntry) {
		addStaticDependenciesToManualChunk(
			entry,
			(manualChunkModulesByAlias[alias] ||= []),
			modulesInManualChunks
		);
	}
	for (const [alias, modules] of Object.entries(manualChunkModulesByAlias)) {
		chunkDefinitions.push({ alias, modules });
	}

	const { allEntries, dependentEntriesByModule, dynamicallyDependentEntriesByDynamicEntry } =
		analyzeModuleGraph(entries);

	const staticEntries = new Set(entries);
	const assignedEntriesByModule: DependentModuleMap = new Map();

	for (const entry of allEntries) {
		if (!modulesInManualChunks.has(entry)) {
			assignEntryToStaticDependencies(
				entry,
				dependentEntriesByModule,
				assignedEntriesByModule,
				modulesInManualChunks,
				staticEntries,
				dynamicallyDependentEntriesByDynamicEntry
			);
		}
	}

	chunkDefinitions.push(...createChunks(allEntries, assignedEntriesByModule, minChunkSize));
	return chunkDefinitions;
}

function addStaticDependenciesToManualChunk(
	entry: Module,
	manualChunkModules: Module[],
	modulesInManualChunks: Set<Module>
): void {
	const modulesToHandle = new Set([entry]);
	for (const module of modulesToHandle) {
		modulesInManualChunks.add(module);
		manualChunkModules.push(module);
		for (const dependency of module.dependencies) {
			if (!(dependency instanceof ExternalModule || modulesInManualChunks.has(dependency))) {
				modulesToHandle.add(dependency);
			}
		}
	}
}

function analyzeModuleGraph(entries: Iterable<Module>): {
	allEntries: Iterable<Module>;
	dependentEntriesByModule: DependentModuleMap;
	dynamicallyDependentEntriesByDynamicEntry: DependentModuleMap;
} {
	const dynamicEntries = new Set<Module>();
	const dependentEntriesByModule: DependentModuleMap = new Map();
	const allEntries = new Set(entries);
	for (const currentEntry of allEntries) {
		const modulesToHandle = new Set([currentEntry]);
		for (const module of modulesToHandle) {
			getOrCreate(dependentEntriesByModule, module, () => new Set()).add(currentEntry);
			for (const dependency of module.getDependenciesToBeIncluded()) {
				if (!(dependency instanceof ExternalModule)) {
					modulesToHandle.add(dependency);
				}
			}
			for (const { resolution } of module.dynamicImports) {
				if (
					resolution instanceof Module &&
					resolution.includedDynamicImporters.length > 0 &&
					!allEntries.has(resolution)
				) {
					dynamicEntries.add(resolution);
					allEntries.add(resolution);
				}
			}
			for (const dependency of module.implicitlyLoadedBefore) {
				if (!allEntries.has(dependency)) {
					dynamicEntries.add(dependency);
					allEntries.add(dependency);
				}
			}
		}
	}
	return {
		allEntries,
		dependentEntriesByModule,
		dynamicallyDependentEntriesByDynamicEntry: getDynamicallyDependentEntriesByDynamicEntry(
			dependentEntriesByModule,
			dynamicEntries
		)
	};
}

function getDynamicallyDependentEntriesByDynamicEntry(
	dependentEntriesByModule: ReadonlyDependentModuleMap,
	dynamicEntries: ReadonlySet<Module>
): DependentModuleMap {
	const dynamicallyDependentEntriesByDynamicEntry: DependentModuleMap = new Map();
	for (const dynamicEntry of dynamicEntries) {
		const dynamicDependentEntries = getOrCreate(
			dynamicallyDependentEntriesByDynamicEntry,
			dynamicEntry,
			() => new Set()
		);
		for (const importer of [
			...dynamicEntry.includedDynamicImporters,
			...dynamicEntry.implicitlyLoadedAfter
		]) {
			for (const entry of dependentEntriesByModule.get(importer)!) {
				dynamicDependentEntries.add(entry);
			}
		}
	}
	return dynamicallyDependentEntriesByDynamicEntry;
}

function assignEntryToStaticDependencies(
	entry: Module,
	dependentEntriesByModule: ReadonlyDependentModuleMap,
	assignedEntriesByModule: DependentModuleMap,
	modulesInManualChunks: ReadonlySet<Module>,
	staticEntries: ReadonlySet<Module>,
	dynamicallyDependentEntriesByDynamicEntry: ReadonlyDependentModuleMap
) {
	const dynamicDependentEntries = dynamicallyDependentEntriesByDynamicEntry.get(entry);
	const modulesToHandle = new Set([entry]);
	for (const module of modulesToHandle) {
		const assignedEntries = getOrCreate(assignedEntriesByModule, module, () => new Set());
		if (
			dynamicDependentEntries &&
			areEntriesContainedOrDynamicallyDependent(
				dynamicDependentEntries,
				dependentEntriesByModule.get(module)!,
				staticEntries,
				dynamicallyDependentEntriesByDynamicEntry
			)
		) {
			continue;
		} else {
			assignedEntries.add(entry);
		}
		for (const dependency of module.getDependenciesToBeIncluded()) {
			if (!(dependency instanceof ExternalModule || modulesInManualChunks.has(dependency))) {
				modulesToHandle.add(dependency);
			}
		}
	}
}

const MAX_ENTRIES_TO_CHECK_FOR_SHARED_DEPENDENCIES = 3;

function areEntriesContainedOrDynamicallyDependent(
	entries: ReadonlySet<Module>,
	containedIn: ReadonlySet<Module>,
	staticEntries: ReadonlySet<Module>,
	dynamicallyDependentEntriesByDynamicEntry: ReadonlyDependentModuleMap
): boolean {
	if (entries.size > MAX_ENTRIES_TO_CHECK_FOR_SHARED_DEPENDENCIES) {
		return false;
	}
	const entriesToCheck = new Set(entries);
	for (const entry of entriesToCheck) {
		if (!containedIn.has(entry)) {
			if (staticEntries.has(entry)) {
				return false;
			}
			const dynamicallyDependentEntries = dynamicallyDependentEntriesByDynamicEntry.get(entry)!;
			if (dynamicallyDependentEntries.size > MAX_ENTRIES_TO_CHECK_FOR_SHARED_DEPENDENCIES) {
				return false;
			}
			for (const dependentEntry of dynamicallyDependentEntries) {
				entriesToCheck.add(dependentEntry);
			}
		}
	}
	return true;
}

interface ChunkDescription {
	modules: Module[];
	pure: boolean;
	signature: string;
	size: number;
}

type ChunkPartition = {
	[key in 'small' | 'big']: {
		[subKey in 'pure' | 'sideEffect']: Set<ChunkDescription>;
	};
};

function createChunks(
	allEntries: Iterable<Module>,
	assignedEntriesByModule: DependentModuleMap,
	minChunkSize: number
): ChunkDefinitions {
	const chunkModulesBySignature = getChunkModulesBySignature(assignedEntriesByModule, allEntries);
	return minChunkSize === 0
		? Object.values(chunkModulesBySignature).map(modules => ({
				alias: null,
				modules
		  }))
		: getOptimizedChunks(chunkModulesBySignature, minChunkSize).map(({ modules }) => ({
				alias: null,
				modules
		  }));
}

function getOptimizedChunks(
	chunkModulesBySignature: { [chunkSignature: string]: Module[] },
	minChunkSize: number
) {
	timeStart('optimize chunks', 3);
	const chunkPartition = getPartitionedChunks(chunkModulesBySignature, minChunkSize);
	console.log(`Created ${
		chunkPartition.big.pure.size +
		chunkPartition.big.sideEffect.size +
		chunkPartition.small.pure.size +
		chunkPartition.small.sideEffect.size
	} chunks
----- pure  side effects
small ${`${chunkPartition.small.pure.size}`.padEnd(5, ' ')} ${chunkPartition.small.sideEffect.size}
  big ${`${chunkPartition.big.pure.size}`.padEnd(5, ' ')} ${chunkPartition.big.sideEffect.size}
`);

	console.log(
		`Trying to find merge targets for ${
			chunkPartition.small.sideEffect.size
		} chunks smaller than ${prettyBytes(minChunkSize)} with side effects...`
	);
	mergeChunks(
		chunkPartition.small.sideEffect,
		[chunkPartition.small.pure, chunkPartition.big.pure],
		minChunkSize,
		chunkPartition
	);
	console.log(
		`${chunkPartition.small.sideEffect.size} chunks smaller than ${prettyBytes(
			minChunkSize
		)} with side effects remaining.\n`
	);

	console.log(
		`Trying to find merge targets for ${
			chunkPartition.small.pure.size
		} pure chunks smaller than ${prettyBytes(minChunkSize)}...`
	);
	mergeChunks(
		chunkPartition.small.pure,
		[chunkPartition.small.pure, chunkPartition.big.sideEffect, chunkPartition.big.pure],
		minChunkSize,
		chunkPartition
	);

	console.log(
		`${chunkPartition.small.pure.size} pure chunks smaller than ${prettyBytes(
			minChunkSize
		)} remaining.\n`
	);
	timeEnd('optimize chunks', 3);
	const result = [
		...chunkPartition.small.sideEffect,
		...chunkPartition.small.pure,
		...chunkPartition.big.sideEffect,
		...chunkPartition.big.pure
	];
	console.log(`${result.length} chunks remaining.`);
	return result;
}

const CHAR_DEPENDENT = 'X';
const CHAR_INDEPENDENT = '_';
const CHAR_CODE_DEPENDENT = CHAR_DEPENDENT.charCodeAt(0);

function getChunkModulesBySignature(
	assignedEntriesByModule: ReadonlyDependentModuleMap,
	allEntries: Iterable<Module>
) {
	const chunkModules: { [chunkSignature: string]: Module[] } = Object.create(null);
	for (const [module, assignedEntries] of assignedEntriesByModule) {
		let chunkSignature = '';
		for (const entry of allEntries) {
			chunkSignature += assignedEntries.has(entry) ? CHAR_DEPENDENT : CHAR_INDEPENDENT;
		}
		const chunk = chunkModules[chunkSignature];
		if (chunk) {
			chunk.push(module);
		} else {
			chunkModules[chunkSignature] = [module];
		}
	}
	return chunkModules;
}

function getPartitionedChunks(
	chunkModulesBySignature: { [chunkSignature: string]: Module[] },
	minChunkSize: number
): ChunkPartition {
	const smallPureChunks: ChunkDescription[] = [];
	const bigPureChunks: ChunkDescription[] = [];
	const smallSideEffectChunks: ChunkDescription[] = [];
	const bigSideEffectChunks: ChunkDescription[] = [];
	for (const [signature, modules] of Object.entries(chunkModulesBySignature)) {
		let size = 0;
		let pure = true;
		for (const module of modules) {
			pure &&= !module.hasEffects();
			size += module.magicString.toString().length;
		}
		(size < minChunkSize
			? pure
				? smallPureChunks
				: smallSideEffectChunks
			: pure
			? bigPureChunks
			: bigSideEffectChunks
		).push({ modules, pure, signature, size });
	}
	for (const chunks of [
		bigPureChunks,
		bigSideEffectChunks,
		smallPureChunks,
		smallSideEffectChunks
	]) {
		chunks.sort(compareChunks);
	}
	return {
		big: { pure: new Set(bigPureChunks), sideEffect: new Set(bigSideEffectChunks) },
		small: { pure: new Set(smallPureChunks), sideEffect: new Set(smallSideEffectChunks) }
	};
}

function compareChunks(
	{ size: sizeA }: ChunkDescription,
	{ size: sizeB }: ChunkDescription
): number {
	return sizeA - sizeB;
}

function mergeChunks(
	chunksToBeMerged: Set<ChunkDescription>,
	targetChunks: Set<ChunkDescription>[],
	minChunkSize: number,
	chunkPartition: ChunkPartition
) {
	for (const mergedChunk of chunksToBeMerged) {
		let closestChunk: ChunkDescription | null = null;
		let closestChunkDistance = Infinity;
		const { signature, modules, pure, size } = mergedChunk;

		for (const targetChunk of concatLazy(targetChunks)) {
			if (mergedChunk === targetChunk) continue;
			const distance = pure
				? getSignatureDistance(signature, targetChunk.signature, !targetChunk.pure)
				: getSignatureDistance(targetChunk.signature, signature, true);
			if (distance === 1) {
				closestChunk = targetChunk;
				break;
			} else if (distance < closestChunkDistance) {
				closestChunk = targetChunk;
				closestChunkDistance = distance;
			}
		}
		if (closestChunk) {
			chunksToBeMerged.delete(mergedChunk);
			getChunksInPartition(closestChunk, minChunkSize, chunkPartition).delete(closestChunk);
			closestChunk.modules.push(...modules);
			closestChunk.size += size;
			closestChunk.pure &&= pure;
			closestChunk.signature = mergeSignatures(signature, closestChunk.signature);
			getChunksInPartition(closestChunk, minChunkSize, chunkPartition).add(closestChunk);
		}
	}
}

function getChunksInPartition(
	chunk: ChunkDescription,
	minChunkSize: number,
	chunkPartition: ChunkPartition
): Set<ChunkDescription> {
	const subPartition = chunk.size < minChunkSize ? chunkPartition.small : chunkPartition.big;
	return chunk.pure ? subPartition.pure : subPartition.sideEffect;
}

function getSignatureDistance(
	sourceSignature: string,
	targetSignature: string,
	enforceSubset: boolean
): number {
	let distance = 0;
	const { length } = sourceSignature;
	for (let index = 0; index < length; index++) {
		const sourceValue = sourceSignature.charCodeAt(index);
		if (sourceValue !== targetSignature.charCodeAt(index)) {
			if (enforceSubset && sourceValue === CHAR_CODE_DEPENDENT) {
				return Infinity;
			}
			distance++;
		}
	}
	return distance;
}

function mergeSignatures(sourceSignature: string, targetSignature: string): string {
	let signature = '';
	const { length } = sourceSignature;
	for (let index = 0; index < length; index++) {
		signature +=
			sourceSignature.charCodeAt(index) === CHAR_CODE_DEPENDENT ||
			targetSignature.charCodeAt(index) === CHAR_CODE_DEPENDENT
				? CHAR_DEPENDENT
				: CHAR_INDEPENDENT;
	}
	return signature;
}
