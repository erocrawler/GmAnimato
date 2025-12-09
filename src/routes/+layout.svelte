<script lang="ts">
	import '../app.css';
	import NavMenu from '$lib/components/NavMenu.svelte';
	import { setLocale, waitLocale } from '$lib/i18n';
	import { locale, _, isLoading } from 'svelte-i18n';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	
	let { children, data }: { children: any; data: any } = $props();
	
	const isAdmin = $derived(data?.user?.roles?.includes('admin') || false);
	let drawerToggle: HTMLInputElement | null = $state(null);

	// Protected routes that require authentication
	const protectedRoutes = ['/new', '/videos', '/profile'];

	onMount(() => {
		// Guard protected routes on client-side navigation
		if (protectedRoutes.some((route) => $page.url.pathname.startsWith(route)) && !data?.user) {
			goto('/login');
		}
	});
	
	function switchLanguage(lang: string) {
		setLocale(lang);
	}
</script>

{#await waitLocale()}
	<!-- Loading state while i18n initializes -->
	<div class="flex items-center justify-center min-h-screen">
		<span class="loading loading-spinner loading-lg"></span>
	</div>
{:then}
<div class="drawer">
	<input bind:this={drawerToggle} id="main-drawer" type="checkbox" class="drawer-toggle" />
	<div class="drawer-content flex flex-col">
		<!-- Navbar -->
		<div class="navbar bg-base-200 shadow-lg">
			<div class="flex-none lg:hidden">
				<label for="main-drawer" aria-label="open sidebar" class="btn btn-square btn-ghost">
					<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" class="inline-block w-6 h-6 stroke-current">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path>
					</svg>
				</label>
			</div>
			<div class="flex-1">
				<a href="/" class="btn btn-ghost text-xl">
					<img src="/apple-touch-icon.png" alt="GmAnimato" class="w-8 h-8" />
					GmAnimato
				</a>
			</div>
			<div class="flex-none">
				<div class="hidden lg:flex lg:items-center lg:gap-2">
					<NavMenu user={data?.user} {isAdmin} orientation="horizontal" />
					<!-- Language Switcher -->
					<div class="dropdown dropdown-end">
						<div tabindex="0" role="button" class="btn btn-ghost btn-sm gap-1">
							<svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
							</svg>
							{$locale === 'zh' ? '中文' : 'EN'}
						</div>
						<ul tabindex="0" class="dropdown-content z-[1] menu p-2 shadow bg-base-100 rounded-box w-32">
							<li><button onclick={() => switchLanguage('en')} class:active={$locale === 'en'}>English</button></li>
							<li><button onclick={() => switchLanguage('zh')} class:active={$locale === 'zh'}>中文</button></li>
						</ul>
					</div>
				</div>
			</div>
	</div>		<!-- Page content -->
		<main class="flex-grow container mx-auto p-4 lg:p-8">
			{@render children()}
		</main>

		<!-- Footer -->
		<footer class="footer footer-center p-4 bg-base-200 text-base-content">
			<aside>
				<p>{$_('home.footer')}</p>
			</aside>
		</footer>
	</div>
	
	<!-- Drawer sidebar -->
	<div class="drawer-side">
		<label for="main-drawer" aria-label="close sidebar" class="drawer-overlay"></label>
		<div class="w-80 min-h-full bg-base-200 p-4">
			<NavMenu user={data?.user} {isAdmin} orientation="vertical" {drawerToggle} />
		</div>
	</div>
</div>
{/await}
