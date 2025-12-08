<script lang="ts">
	import { _ } from 'svelte-i18n';
</script>

<div class="hero min-h-[60vh] bg-base-200 rounded-lg">
	<div class="hero-content text-center">
		<div class="max-w-3xl">
			<div class="flex justify-center mb-6">
				<img src="/images/LOGO.png" alt="Visualize AI Logo" class="w-64 h-auto" />
			</div>
			<h1 class="text-5xl font-bold mb-4">{$_('home.title')}</h1>
			<p class="py-6 text-lg">
				{$_('home.subtitle')}
			</p>
			<a href="/new" class="btn btn-primary btn-lg">{$_('home.getStarted')}</a>
		</div>
	</div>
</div>

<div class="divider my-8"></div>

<h2 class="text-3xl font-bold text-center mb-6">{$_('home.quickStart')}</h2>

<div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-12">
	<div class="card bg-base-100 shadow-xl">
		<div class="card-body">
			<div class="text-4xl mb-2">🎨</div>
			<h2 class="card-title">{$_('home.createCard.title')}</h2>
			<p>{$_('home.createCard.description')}</p>
			<div class="card-actions justify-end">
				<a href="/new" class="btn btn-primary">{$_('home.createCard.button')}</a>
			</div>
		</div>
	</div>

	<div class="card bg-base-100 shadow-xl">
		<div class="card-body">
			<div class="text-4xl mb-2">📹</div>
			<h2 class="card-title">{$_('home.myVideosCard.title')}</h2>
			<p>{$_('home.myVideosCard.description')}</p>
			<div class="card-actions justify-end">
				<a href="/videos" class="btn btn-secondary">{$_('home.myVideosCard.button')}</a>
			</div>
		</div>
	</div>

	<div class="card bg-base-100 shadow-xl">
		<div class="card-body">
			<div class="text-4xl mb-2">🖼️</div>
			<h2 class="card-title">{$_('home.galleryCard.title')}</h2>
			<p>{$_('home.galleryCard.description')}</p>
			<div class="card-actions justify-end">
				<a href="/gallery" class="btn btn-accent">{$_('home.galleryCard.button')}</a>
			</div>
		</div>
	</div>
</div>

<h2 class="text-3xl font-bold mb-4">{$_('home.howItWorks')}</h2>

<div class="steps steps-vertical lg:steps-horizontal w-full mb-12">
	<div class="step step-primary">
		<div class="text-left">
			<h3 class="font-bold">{$_('home.steps.upload.title')}</h3>
			<p class="text-sm">{$_('home.steps.upload.description')}</p>
		</div>
	</div>
	<div class="step step-primary">
		<div class="text-left">
			<h3 class="font-bold">{$_('home.steps.process.title')}</h3>
			<p class="text-sm">{$_('home.steps.process.description')}</p>
		</div>
	</div>
	<div class="step step-primary">
		<div class="text-left">
			<h3 class="font-bold">{$_('home.steps.ready.title')}</h3>
			<p class="text-sm">{$_('home.steps.ready.description')}</p>
		</div>
	</div>
	<div class="step step-primary">
		<div class="text-left">
			<h3 class="font-bold">{$_('home.steps.share.title')}</h3>
			<p class="text-sm">{$_('home.steps.share.description')}</p>
		</div>
	</div>
</div>
