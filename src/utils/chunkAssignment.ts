import ExternalModule from '../ExternalModule';
import Module from '../Module';
import { getOrCreate } from './getOrCreate';
import { concatLazy } from './iterators';
import { timeEnd, timeStart } from './timers';

type DependentModuleMap = Map<Module, Set<Module>>;
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
	const alreadyLoadedModulesByDynamicEntry = getAlreadyLoadedModulesByDynamicEntry(entries);
	const assignedEntryPointsByModule: DependentModuleMap = new Map();

	for (const entry of entries) {
		if (!modulesInManualChunks.has(entry)) {
			assignEntryToStaticDependencies(
				entry,
				undefined,
				assignedEntryPointsByModule,
				modulesInManualChunks
			);
		}
	}

	for (const entry of alreadyLoadedModulesByDynamicEntry.keys()) {
		if (!modulesInManualChunks.has(entry)) {
			assignEntryToStaticDependencies(
				entry,
				alreadyLoadedModulesByDynamicEntry.get(entry),
				assignedEntryPointsByModule,
				modulesInManualChunks
			);
		}
	}

	chunkDefinitions.push(
		...createChunks(
			[...entries, ...alreadyLoadedModulesByDynamicEntry.keys()],
			assignedEntryPointsByModule,
			minChunkSize
		)
	);
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

function getAlreadyLoadedModulesByDynamicEntry(
	entryModules: readonly Module[]
): DependentModuleMap {
	const allModules = new Set(entryModules);
	const dependentEntryPointsByModule: DependentModuleMap = new Map();
	const dynamicImportsByEntry: DependentModuleMap = new Map();
	const dynamicallyDependentEntryPointsByDynamicEntry: DependentModuleMap = new Map();
	const entriesToHandle = new Set(entryModules);
	for (const currentEntry of entriesToHandle) {
		const modulesToHandle = new Set([currentEntry]);
		const dynamicImports = new Set<Module>();
		dynamicImportsByEntry.set(currentEntry, dynamicImports);
		for (const module of modulesToHandle) {
			getOrCreate(dependentEntryPointsByModule, module, () => new Set()).add(currentEntry);
			for (const dependency of module.getDependenciesToBeIncluded()) {
				if (!(dependency instanceof ExternalModule)) {
					modulesToHandle.add(dependency);
					allModules.add(dependency);
				}
			}
			for (const { resolution } of module.dynamicImports) {
				if (resolution instanceof Module && resolution.includedDynamicImporters.length > 0) {
					dynamicImports.add(resolution);
					getOrCreate(
						dynamicallyDependentEntryPointsByDynamicEntry,
						resolution,
						() => new Set()
					).add(currentEntry);
					entriesToHandle.add(resolution);
					allModules.add(resolution);
				}
			}
			for (const dependency of module.implicitlyLoadedBefore) {
				dynamicImports.add(dependency);
				getOrCreate(dynamicallyDependentEntryPointsByDynamicEntry, dependency, () => new Set()).add(
					currentEntry
				);
				entriesToHandle.add(dependency);
				allModules.add(dependency);
			}
		}
	}
	return buildAlreadyLoadedModulesByDynamicEntry(
		allModules,
		dependentEntryPointsByModule,
		dynamicImportsByEntry,
		dynamicallyDependentEntryPointsByDynamicEntry
	);
}

function buildAlreadyLoadedModulesByDynamicEntry(
	allModules: Set<Module>,
	dependentEntryPointsByModule: DependentModuleMap,
	dynamicImportsByEntry: DependentModuleMap,
	dynamicallyDependentEntryPointsByDynamicEntry: DependentModuleMap
): DependentModuleMap {
	const alreadyLoadedModulesByDynamicEntry: DependentModuleMap = new Map();
	for (const dynamicEntry of dynamicallyDependentEntryPointsByDynamicEntry.keys()) {
		alreadyLoadedModulesByDynamicEntry.set(dynamicEntry, new Set());
	}
	for (const module of allModules) {
		const dependentEntryPoints = dependentEntryPointsByModule.get(module)!;
		for (const entry of dependentEntryPoints) {
			const dynamicEntriesToHandle = [...dynamicImportsByEntry.get(entry)!];
			nextDynamicEntry: for (const dynamicEntry of dynamicEntriesToHandle) {
				const alreadyLoadedModules = alreadyLoadedModulesByDynamicEntry.get(dynamicEntry)!;
				if (alreadyLoadedModules.has(module)) {
					continue;
				}
				for (const siblingDependentEntry of dynamicallyDependentEntryPointsByDynamicEntry.get(
					dynamicEntry
				)!) {
					if (
						!(
							dependentEntryPoints.has(siblingDependentEntry) ||
							alreadyLoadedModulesByDynamicEntry.get(siblingDependentEntry)?.has(module)
						)
					) {
						continue nextDynamicEntry;
					}
				}
				alreadyLoadedModules.add(module);
				dynamicEntriesToHandle.push(...dynamicImportsByEntry.get(dynamicEntry)!);
			}
		}
	}
	return alreadyLoadedModulesByDynamicEntry;
}

function assignEntryToStaticDependencies(
	entry: Module,
	alreadyLoadedModules: ReadonlySet<Module> | undefined,
	assignedEntryPointsByModule: DependentModuleMap,
	modulesInManualChunks: Set<Module>
) {
	const modulesToHandle = new Set([entry]);
	for (const module of modulesToHandle) {
		const assignedEntryPoints = getOrCreate(assignedEntryPointsByModule, module, () => new Set());
		// If the module is "already loaded" for this dynamic entry, we do not need
		// to mark it for this dynamic entry
		if (alreadyLoadedModules?.has(module)) {
			continue;
		} else {
			assignedEntryPoints.add(entry);
		}
		for (const dependency of module.getDependenciesToBeIncluded()) {
			if (!(dependency instanceof ExternalModule || modulesInManualChunks.has(dependency))) {
				modulesToHandle.add(dependency);
			}
		}
	}
}

interface ChunkDescription {
	alias: null;
	modules: Module[];
	signature: string;
	size: number | null;
}

interface MergeableChunkDescription extends ChunkDescription {
	size: number;
}

function createChunks(
	allEntryPoints: readonly Module[],
	assignedEntryPointsByModule: DependentModuleMap,
	minChunkSize: number
): ChunkDefinitions {
	const chunkModulesBySignature = getChunkModulesBySignature(
		assignedEntryPointsByModule,
		allEntryPoints
	);
	return minChunkSize === 0
		? Object.values(chunkModulesBySignature).map(modules => ({
				alias: null,
				modules
		  }))
		: getOptimizedChunks(chunkModulesBySignature, minChunkSize);
}

function getOptimizedChunks(
	chunkModulesBySignature: { [chunkSignature: string]: Module[] },
	minChunkSize: number
) {
	timeStart('optimize chunks', 3);
	const { chunksToBeMerged, unmergeableChunks } = getMergeableChunks(
		chunkModulesBySignature,
		minChunkSize
	);
	for (const sourceChunk of chunksToBeMerged) {
		chunksToBeMerged.delete(sourceChunk);
		let closestChunk: ChunkDescription | null = null;
		let closestChunkDistance = Infinity;
		const { signature, size, modules } = sourceChunk;

		for (const targetChunk of concatLazy(chunksToBeMerged, unmergeableChunks)) {
			const distance = getSignatureDistance(
				signature,
				targetChunk.signature,
				!chunksToBeMerged.has(targetChunk)
			);
			if (distance === 1) {
				closestChunk = targetChunk;
				break;
			} else if (distance < closestChunkDistance) {
				closestChunk = targetChunk;
				closestChunkDistance = distance;
			}
		}
		if (closestChunk) {
			closestChunk.modules.push(...modules);
			if (chunksToBeMerged.has(closestChunk)) {
				closestChunk.signature = mergeSignatures(signature, closestChunk.signature);
				if ((closestChunk.size += size) > minChunkSize) {
					chunksToBeMerged.delete(closestChunk);
					unmergeableChunks.push(closestChunk);
				}
			}
		} else {
			unmergeableChunks.push(sourceChunk);
		}
	}
	timeEnd('optimize chunks', 3);
	return unmergeableChunks;
}

const CHAR_DEPENDENT = 'X';
const CHAR_INDEPENDENT = '_';
const CHAR_CODE_DEPENDENT = CHAR_DEPENDENT.charCodeAt(0);

function getChunkModulesBySignature(
	assignedEntryPointsByModule: Map<Module, Set<Module>>,
	allEntryPoints: readonly Module[]
) {
	const chunkModules: { [chunkSignature: string]: Module[] } = Object.create(null);
	for (const [module, assignedEntryPoints] of assignedEntryPointsByModule) {
		let chunkSignature = '';
		for (const entry of allEntryPoints) {
			chunkSignature += assignedEntryPoints.has(entry) ? CHAR_DEPENDENT : CHAR_INDEPENDENT;
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

function getMergeableChunks(
	chunkModulesBySignature: { [chunkSignature: string]: Module[] },
	minChunkSize: number
) {
	const chunksToBeMerged = new Set() as Set<MergeableChunkDescription> & {
		has(chunk: unknown): chunk is MergeableChunkDescription;
	};
	const unmergeableChunks: ChunkDescription[] = [];
	const alias = null;
	for (const [signature, modules] of Object.entries(chunkModulesBySignature)) {
		let size = 0;
		checkModules: {
			for (const module of modules) {
				if (module.hasEffects()) {
					break checkModules;
				}
				size += module.magicString.toString().length;
				if (size > minChunkSize) {
					break checkModules;
				}
			}
			chunksToBeMerged.add({ alias, modules, signature, size });
			continue;
		}
		unmergeableChunks.push({ alias, modules, signature, size: null });
	}
	return { chunksToBeMerged, unmergeableChunks };
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
