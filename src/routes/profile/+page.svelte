<script lang="ts">
  import { _ } from 'svelte-i18n';
  import type { PageData } from './$types';
  
  let { data }: { data: PageData } = $props();
  
  let user = $derived(data.user);
  let isGmGardUser = $derived(user?.roles?.includes('gmgard-user'));
  
  // Quota information
  let quotaData = $state<{ used: number; limit: number; remaining: number; exceeded: boolean } | null>(null);
  let loadingQuota = $state(true);
  
  // Toast notification system
  let toastMessage = $state('');
  let toastType: 'success' | 'error' | 'info' = $state('info');
  let showToast = $state(false);
  
  function showNotification(message: string, type: 'success' | 'error' | 'info' = 'info') {
    toastMessage = message;
    toastType = type;
    showToast = true;
    setTimeout(() => showToast = false, 3000);
  }
  
  // Account info form
  let email = $state('');
  let savingInfo = $state(false);
  
  // Sync email from user
  $effect(() => {
    email = user?.email || '';
  });
  
  // Password change form
  let currentPassword = $state('');
  let newPassword = $state('');
  let confirmPassword = $state('');
  let changingPassword = $state(false);
  
  // Sponsor claim form
  let sponsorUsername = $state('');
  let searchingSponsor = $state(false);
  let foundSponsor: any = $state(null);
  let roleToApply = $state('');
  let showSponsorConfirm = $state(false);
  let claimingSponso = $state(false);
  let updatingSponsorship = $state(false);
  
  // Fetch quota on mount
  import { onMount } from 'svelte';
  
  onMount(async () => {
    try {
      const response = await fetch('/api/quota');
      if (response.ok) {
        quotaData = await response.json();
      }
    } catch (err) {
      console.error('Failed to fetch quota:', err);
    } finally {
      loadingQuota = false;
    }
  });
  
  // Sponsor configuration
  import { isTokenExpired } from '$lib/jwt';
  
  let sponsorApiConfigured = $derived(!!(data.sponsorApiUrl && data.sponsorApiToken));
  let sponsorClaims = $derived(data.sponsorClaims || []);
  let currentClaim = $derived(sponsorClaims.length > 0 ? sponsorClaims[0] : null);
  let tokenExpired = $derived(isTokenExpired(data.sponsorApiToken));
  let sponsorFeatureDisabled = $derived(!sponsorApiConfigured || tokenExpired);
  
  async function searchSponsor() {
    if (!sponsorUsername.trim()) {
      showNotification($_('profile.sponsor.errors.usernameRequired'), 'error');
      return;
    }
    
    searchingSponsor = true;
    
    try {
      const response = await fetch('/api/profile/claim-sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: sponsorUsername.trim() }),
      });
      
      if (response.ok) {
        const result = await response.json();
        if (result.found) {
          foundSponsor = result.sponsor;
          roleToApply = result.roleToApply || '';
          
          // Handle different message codes
          if (result.messageCode) {
            const messageKey = getMessageKey(result.messageCode);
            const message = $_(`profile.sponsor.backend.${messageKey}`, {
              values: { role: result.currentRole || result.role || '' }
            });
            
            // Show info and don't open dialog for certain cases
            if (['ALREADY_CLAIMED_BY_SELF', 'ALREADY_HAS_ROLE'].includes(result.messageCode)) {
              showNotification(message, 'info');
              showSponsorConfirm = false;
              foundSponsor = null;
            } else {
              showSponsorConfirm = true;
              showNotification($_('profile.sponsor.success.found'), 'success');
            }
          } else {
            // Normal case: show confirmation dialog
            showSponsorConfirm = true;
            showNotification($_('profile.sponsor.success.found'), 'success');
          }
        } else {
          const messageKey = result.messageCode ? getMessageKey(result.messageCode) : 'notFound';
          showNotification($_(`profile.sponsor.backend.${messageKey}`), 'error');
          foundSponsor = null;
        }
      } else {
        const result = await response.json();
        const messageKey = result.messageCode ? getMessageKey(result.messageCode) : 'searchFailed';
        showNotification($_(`profile.sponsor.errors.${messageKey}`), 'error');
        foundSponsor = null;
      }
    } catch (err) {
      showNotification($_('common.error') + ': ' + String(err), 'error');
      foundSponsor = null;
    } finally {
      searchingSponsor = false;
    }
  }
  
  function getMessageKey(code: string): string {
    const mapping: Record<string, string> = {
      'NOT_FOUND': 'notFound',
      'ALREADY_CLAIMED_BY_SELF': 'alreadyClaimedBySelf',
      'ALREADY_CLAIMED_BY_OTHER': 'alreadyClaimedByOther',
      'ALREADY_HAS_ROLE': 'alreadyHasRole',
      'USERNAME_REQUIRED': 'usernameRequired',
      'SEARCH_FAILED': 'searchFailed',
      'VERIFICATION_FAILED': 'verificationFailed',
      'INVALID_ROLE': 'invalidRole',
      'UPDATE_ROLES_FAILED': 'updateRolesFailed',
      'CLAIM_SUCCESS': 'claimSuccess',
      'UPDATE_SUCCESS': 'updateSuccess',
      'NO_CHANGE_NEEDED': 'noChangeNeeded',
      'CLAIM_FAILED': 'claimFailed',
    };
    return mapping[code] || code.toLowerCase();
  }
  
  async function confirmSponsorClaim() {
    if (!foundSponsor || !roleToApply) return;
    
    claimingSponso = true;
    
    try {
      const response = await fetch('/api/profile/claim-sponsor', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          username: sponsorUsername.trim(),
          roleToApply 
        }),
      });
      
      if (response.ok) {
        const result = await response.json();
        user = result.user;
        
        // Handle message code
        const messageKey = result.messageCode ? getMessageKey(result.messageCode) : 'claimSuccess';
        const message = $_(`profile.sponsor.backend.${messageKey}`, {
          values: { role: result.role || roleToApply }
        });
        
        showNotification(message, 'success');
        sponsorUsername = '';
        foundSponsor = null;
        roleToApply = '';
        showSponsorConfirm = false;
      } else {
        const result = await response.json();
        const messageKey = result.messageCode ? getMessageKey(result.messageCode) : 'claimFailed';
        showNotification($_(`profile.sponsor.errors.${messageKey}`), 'error');
      }
    } catch (err) {
      showNotification($_('common.error') + ': ' + String(err), 'error');
    } finally {
      claimingSponso = false;
    }
  }
  
  function closeSponsorConfirm() {
    showSponsorConfirm = false;
    foundSponsor = null;
    roleToApply = '';
  }
  
  async function updateSponsorship() {
    if (!currentClaim) return;
    
    updatingSponsorship = true;
    
    try {
      // Search for the sponsor again to check if tier changed
      const response = await fetch('/api/profile/claim-sponsor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: currentClaim.sponsor_username }),
      });
      
      if (response.ok) {
        const result = await response.json();
        if (result.found && result.sponsor) {
          const sponsor = result.sponsor;
          // Check if tier changed
          if (sponsor.schemeName !== currentClaim.sponsor_tier) {
            // Tier changed, need to update
            sponsorUsername = currentClaim.sponsor_username;
            foundSponsor = sponsor;
            roleToApply = result.roleToApply || '';
            showSponsorConfirm = true;
            showNotification($_('profile.sponsor.success.tierChanged'), 'info');
          } else {
            showNotification($_('profile.sponsor.success.upToDate'), 'success');
          }
        } else {
          showNotification(result.message || $_('profile.sponsor.errors.expired'), 'error');
        }
      } else {
        const result = await response.json();
        showNotification(result.error || $_('profile.sponsor.errors.updateFailed'), 'error');
      }
    } catch (err) {
      showNotification($_('common.error') + ': ' + String(err), 'error');
    } finally {
      updatingSponsorship = false;
    }
  }
  
  async function updateAccountInfo() {
    savingInfo = true;
    
    try {
      const response = await fetch('/api/profile/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      
      if (response.ok) {
        const result = await response.json();
        user = result.user;
        showNotification($_('profile.accountUpdated'), 'success');
      } else {
        const result = await response.json();
        showNotification(result.error || $_('profile.updateError'), 'error');
      }
    } catch (err) {
      showNotification($_('common.error') + ': ' + String(err), 'error');
    } finally {
      savingInfo = false;
    }
  }
  
  async function changePassword() {
    if (newPassword !== confirmPassword) {
      showNotification($_('profile.passwordMismatch'), 'error');
      return;
    }
    
    if (newPassword.length < 6) {
      showNotification($_('profile.passwordTooShort'), 'error');
      return;
    }
    
    changingPassword = true;
    
    try {
      const response = await fetch('/api/profile/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          currentPassword, 
          newPassword 
        }),
      });
      
      if (response.ok) {
        showNotification($_('profile.passwordChanged'), 'success');
        currentPassword = '';
        newPassword = '';
        confirmPassword = '';
      } else {
        const result = await response.json();
        showNotification(result.error || $_('profile.changePasswordError'), 'error');
      }
    } catch (err) {
      showNotification($_('common.error') + ': ' + String(err), 'error');
    } finally {
      changingPassword = false;
    }
  }
</script>

<div class="container mx-auto p-6 max-w-4xl">
  <h1 class="text-3xl font-bold mb-6">{$_('profile.title')}</h1>
  
  <!-- Floating Toast Notification -->
  {#if showToast}
    <div class="toast toast-top toast-end z-50">
      <div class="alert" class:alert-success={toastType === 'success'} class:alert-error={toastType === 'error'} class:alert-info={toastType === 'info'}>
        <span>{toastMessage}</span>
      </div>
    </div>
  {/if}
  
  <!-- Account Information -->
  <div class="card bg-base-200 shadow-xl mb-6">
    <div class="card-body">
      <h2 class="card-title text-2xl mb-4">{$_('profile.accountInformation')}</h2>
      
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-control">
          <label class="label" for="username">
            <span class="label-text">{$_('profile.username')}</span>
          </label>
          <input 
            id="username"
            type="text" 
            value={user.username} 
            disabled 
            class="input input-bordered bg-base-300" 
          />
          <div class="label">
            <span class="label-text-alt">{$_('profile.usernameCannotChange')}</span>
          </div>
        </div>
        
        <div class="form-control">
          <label class="label" for="email">
            <span class="label-text">{$_('profile.email')}</span>
          </label>
          <input 
            id="email"
            type="email" 
            bind:value={email} 
            class="input input-bordered" 
            placeholder="your@email.com"
          />
        </div>
        
        <div class="form-control">
          <label class="label" for="user-id">
            <span class="label-text">{$_('profile.userId')}</span>
          </label>
          <input 
            id="user-id"
            type="text" 
            value={user.id} 
            disabled 
            class="input input-bordered bg-base-300 font-mono text-sm" 
          />
        </div>
        
        <div class="form-control">
          <label class="label" for="member-since">
            <span class="label-text">{$_('profile.memberSince')}</span>
          </label>
          <input 
            id="member-since"
            type="text" 
            value={new Date(user.created_at).toLocaleDateString()} 
            disabled 
            class="input input-bordered bg-base-300" 
          />
        </div>
        
        <div class="form-control md:col-span-2">
          <div class="label">
            <span class="label-text">{$_('profile.roles')}</span>
          </div>
          <div class="flex gap-2 flex-wrap">
            {#each user.roles as role}
              <span class="badge badge-lg">
                {role}
              </span>
            {/each}
          </div>
        </div>
      </div>
      
      <div class="card-actions justify-end mt-4">
        <button 
          class="btn btn-primary" 
          onclick={updateAccountInfo} 
          disabled={savingInfo}
        >
          {savingInfo ? $_('profile.saving') : $_('profile.saveChanges')}
        </button>
      </div>
    </div>
  </div>
  
  <!-- Daily Quota Section -->
  <div class="card bg-base-200 shadow-xl mb-6">
    <div class="card-body">
      <h2 class="card-title text-2xl mb-4">{$_('profile.dailyQuota.title')}</h2>
      
      {#if loadingQuota}
        <div class="flex justify-center py-8">
          <span class="loading loading-spinner loading-lg"></span>
        </div>
      {:else if quotaData}
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div class="stat bg-base-300 rounded-lg">
            <div class="stat-title">{$_('profile.dailyQuota.used')}</div>
            <div class="stat-value text-primary">{quotaData.used}</div>
            <div class="stat-desc">{$_('profile.dailyQuota.videosToday')}</div>
          </div>
          
          <div class="stat bg-base-300 rounded-lg">
            <div class="stat-title">{$_('profile.dailyQuota.limit')}</div>
            <div class="stat-value">{quotaData.limit}</div>
            <div class="stat-desc">{$_('profile.dailyQuota.dailyLimit')}</div>
          </div>
          
          <div class="stat bg-base-300 rounded-lg">
            <div class="stat-title">{$_('profile.dailyQuota.remaining')}</div>
            <div class="stat-value" class:text-success={quotaData.remaining > 0} class:text-error={quotaData.remaining === 0}>
              {quotaData.remaining}
            </div>
            <div class="stat-desc">{$_('profile.dailyQuota.videosLeft')}</div>
          </div>
        </div>
        
        {#if quotaData.exceeded}
          <div class="alert alert-warning mt-4">
            <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{$_('profile.dailyQuota.exceeded')}</span>
          </div>
        {/if}
        
        <div class="text-sm opacity-70 mt-4">
          <p>{$_('profile.dailyQuota.resetInfo')}</p>
        </div>
      {:else}
        <div class="alert alert-error">
          <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{$_('profile.dailyQuota.loadError')}</span>
        </div>
      {/if}
    </div>
  </div>
  
  <!-- Claim Sponsor Section -->
  {#if sponsorApiConfigured}
    <div class="card bg-base-200 shadow-xl mb-6" class:opacity-50={sponsorFeatureDisabled}>
      <div class="card-body">
        <h2 class="card-title text-2xl mb-4">{$_('profile.sponsor.title')}</h2>
        
        {#if tokenExpired}
          <div class="alert alert-warning mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{$_('profile.sponsor.tokenExpired')}</span>
          </div>
        {:else if currentClaim}
          <!-- Existing Sponsor Claim -->
          <div class="hover-3d mb-4">
            <div class="card bg-gradient-to-br from-primary/10 to-secondary/10 shadow-lg">
              <div class="card-body">
              <h3 class="card-title text-lg mb-3 flex items-center gap-2">
                <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-primary" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
                {$_('profile.sponsor.currentSponsorship')}
              </h3>
              <div class="flex items-start gap-4">
                {#if currentClaim.sponsor_avatar}
                  <div class="avatar">
                    <div class="w-20 h-20 rounded-full ring ring-primary ring-offset-base-100 ring-offset-2">
                      <img 
                        src={currentClaim.sponsor_avatar} 
                        alt={currentClaim.sponsor_nickname}
                      />
                    </div>
                  </div>
                {/if}
                <div class="flex-1">
                  <p class="font-bold text-lg">{currentClaim.sponsor_nickname || 'N/A'}</p>
                  <p class="text-sm opacity-70">@{currentClaim.sponsor_username}</p>
                  <div class="flex gap-2 mt-3">
                    <span class="badge badge-primary badge-lg">{currentClaim.sponsor_tier}</span>
                    <span class="badge badge-ghost badge-lg">{currentClaim.applied_role}</span>
                  </div>
                  <p class="text-xs opacity-60 mt-3">
                    <svg xmlns="http://www.w3.org/2000/svg" class="h-3 w-3 inline mr-1" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 000 2h8a1 1 0 100-2H6z" clip-rule="evenodd" />
                    </svg>
                    {$_('profile.sponsor.claimedOn')} {new Date(currentClaim.claimed_at).toLocaleDateString()}
                  </p>
                </div>
              </div>
            </div>
            </div>
            <!-- 8 empty divs needed for the 3D effect -->
            <div></div>
            <div></div>
            <div></div>
            <div></div>
            <div></div>
            <div></div>
            <div></div>
            <div></div>
          </div>
          <div class="mt-4">
            <button 
              class="btn btn-sm btn-primary" 
              onclick={updateSponsorship}
              disabled={updatingSponsorship || sponsorFeatureDisabled}
            >
              {#if updatingSponsorship}
                <span class="loading loading-spinner loading-xs"></span>
              {/if}
              {updatingSponsorship ? $_('profile.sponsor.checking') : $_('profile.sponsor.checkForUpdates')}
            </button>
          </div>
        {:else}
          <!-- Claim New Sponsorship -->
          <p class="text-sm opacity-70 mb-4">{$_('profile.sponsor.claimDescription')}</p>
          
          <div class="form-control mb-4">
            <label class="label" for="sponsor-username">
              <span class="label-text">{$_('profile.sponsor.usernameLabel')}</span>
            </label>
            <div class="join w-full">
              <input 
                id="sponsor-username"
                type="text" 
                bind:value={sponsorUsername}
                class="input input-bordered join-item flex-1" 
                placeholder={$_('profile.sponsor.searchPlaceholder')}
                disabled={searchingSponsor || claimingSponso || sponsorFeatureDisabled}
              />
              <button 
                class="btn join-item btn-primary" 
                onclick={searchSponsor}
                disabled={searchingSponsor || claimingSponso || !sponsorUsername.trim() || sponsorFeatureDisabled}
              >
                {searchingSponsor ? $_('profile.sponsor.searching') : $_('profile.sponsor.searchButton')}
              </button>
            </div>
            <p class="label-text-alt text-xs opacity-60 mt-2">
              {$_('profile.sponsor.usernameHelp')}
            </p>
          </div>
        {/if}
      </div>
    </div>
  {/if}
  
  <!-- Sponsor Confirmation Modal -->
  {#if showSponsorConfirm && foundSponsor}
    <div class="modal modal-open">
      <div class="modal-box">
        <h3 class="font-bold text-lg mb-4">{$_('profile.sponsor.confirmTitle')}</h3>
        
        <div class="mb-4">
          <p class="text-sm mb-3">{$_('profile.sponsor.confirmDescription')}</p>
          
          <div class="flex items-start gap-4 mb-4">
            {#if foundSponsor.fansAvatar}
              <img 
                src={foundSponsor.fansAvatar} 
                alt={foundSponsor.fansNickname}
                class="w-16 h-16 rounded-full object-cover"
              />
            {/if}
            <div>
              <p class="font-semibold">{foundSponsor.fansNickname}</p>
              <p class="text-sm opacity-70">@{foundSponsor.fansDomainName}</p>
              <p class="text-sm opacity-70">{$_('profile.sponsor.confirmTier')} <span class="badge badge-sm">{foundSponsor.schemeName}</span></p>
            </div>
          </div>
          
          {#if roleToApply}
            <div class="alert alert-info mb-4">
              <span>{@html $_('profile.sponsor.confirmBenefit', { values: { role: roleToApply } })}</span>
            </div>
          {:else}
            <div class="alert alert-warning mb-4">
              <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 h-6 w-6" fill="none" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>{$_('profile.sponsor.confirmNoRole')}</span>
            </div>
          {/if}
        </div>
        
        <div class="modal-action">
          <button class="btn btn-ghost" onclick={closeSponsorConfirm}>{$_('profile.sponsor.cancel')}</button>
          <button 
            class="btn btn-primary" 
            onclick={confirmSponsorClaim}
            disabled={claimingSponso || !roleToApply}
          >
            {claimingSponso ? $_('profile.sponsor.claiming') : $_('profile.sponsor.confirmButton')}
          </button>
        </div>
      </div>
      <button 
        class="modal-backdrop" 
        type="button" 
        onclick={closeSponsorConfirm} 
        aria-label="Close modal"
      ></button>
    </div>
  {/if}
  
  <!-- Change Password (hidden for GmGard OAuth users) -->
  {#if !isGmGardUser}
    <div class="card bg-base-200 shadow-xl">
      <div class="card-body">
        <h2 class="card-title text-2xl mb-4">{$_('profile.changePassword')}</h2>
        
        <form onsubmit={(e) => { e.preventDefault(); changePassword(); }}>
          <div class="grid grid-cols-1 gap-4">
            <div class="form-control">
              <label class="label" for="current-password">
                <span class="label-text">{$_('profile.currentPassword')}</span>
              </label>
              <input 
                id="current-password"
                type="password" 
                bind:value={currentPassword} 
                class="input input-bordered" 
                placeholder={$_('profile.currentPasswordPlaceholder')}
                required
              />
            </div>
            
            <div class="form-control">
              <label class="label" for="new-password">
                <span class="label-text">{$_('profile.newPassword')}</span>
              </label>
              <input 
                id="new-password"
                type="password" 
                bind:value={newPassword} 
                class="input input-bordered" 
                placeholder={$_('profile.newPasswordPlaceholder')}
                required
                minlength="6"
              />
            </div>
            
            <div class="form-control">
              <label class="label" for="confirm-password">
                <span class="label-text">{$_('profile.confirmPassword')}</span>
              </label>
              <input 
                id="confirm-password"
                type="password" 
                bind:value={confirmPassword} 
                class="input input-bordered" 
                placeholder={$_('profile.confirmPasswordPlaceholder')}
                required
                minlength="6"
              />
            </div>
          </div>
          
          <div class="card-actions justify-end mt-4">
            <button 
              type="submit" 
              class="btn btn-primary" 
              disabled={changingPassword}
            >
              {changingPassword ? $_('profile.changingPassword') : $_('profile.changePasswordButton')}
            </button>
          </div>
        </form>
      </div>
    </div>
  {:else}
    <div class="alert alert-info shadow">
      {$_('profile.gmgardOAuthMessage')}
    </div>
  {/if}
</div>
