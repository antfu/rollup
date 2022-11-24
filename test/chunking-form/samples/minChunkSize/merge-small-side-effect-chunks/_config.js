module.exports = {
	solo: true,
	description: 'merges small chunks with side effects into suitable pure chunks',
	options: {
		input: ['main1.js', 'main2.js'],
		output: {
			experimentalMinChunkSize: 100
		}
	}
};
