<script lang="ts">
  import { _ } from 'svelte-i18n';
  import type { PageData } from './$types';
  
  export let data: PageData;
  
  let user = data.user;
  const isGmGardUser = user.roles?.includes('gmgard-user');
  let message = '';
  let error = '';
  
  // Account info form
  let email = user.email || '';
  let savingInfo = false;
  
  // Password change form
  let currentPassword = '';
  let newPassword = '';
  let confirmPassword = '';
  let changingPassword = false;
  
  async function updateAccountInfo() {
    savingInfo = true;
    message = '';
    error = '';
    
    try {
      const response = await fetch('/api/profile/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      
      if (response.ok) {
        const result = await response.json();
        user = result.user;
        message = $_('profile.accountUpdated');
        setTimeout(() => message = '', 3000);
      } else {
        const result = await response.json();
        error = '✗ ' + (result.error || $_('profile.updateError'));
      }
    } catch (err) {
      error = '✗ ' + $_('common.error') + ': ' + String(err);
    } finally {
      savingInfo = false;
    }
  }
  
  async function changePassword() {
    if (newPassword !== confirmPassword) {
      error = '✗ ' + $_('profile.passwordMismatch');
      return;
    }
    
    if (newPassword.length < 6) {
      error = '✗ ' + $_('profile.passwordTooShort');
      return;
    }
    
    changingPassword = true;
    message = '';
    error = '';
    
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
        message = $_('profile.passwordChanged');
        currentPassword = '';
        newPassword = '';
        confirmPassword = '';
        setTimeout(() => message = '', 3000);
      } else {
        const result = await response.json();
        error = '✗ ' + (result.error || $_('profile.changePasswordError'));
      }
    } catch (err) {
      error = '✗ ' + $_('common.error') + ': ' + String(err);
    } finally {
      changingPassword = false;
    }
  }
</script>

<div class="container mx-auto p-6 max-w-4xl">
  <h1 class="text-3xl font-bold mb-6">{$_('profile.title')}</h1>
  
  {#if message}
    <div class="alert alert-success mb-4">
      {message}
    </div>
  {/if}
  
  {#if error}
    <div class="alert alert-error mb-4">
      {error}
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
              <span 
                class="badge badge-lg" 
                class:badge-primary={role === 'admin'}
                class:badge-success={role === 'paid-tier'}
                class:badge-ghost={role === 'free-tier'}
              >
                {role}
              </span>
            {/each}
          </div>
        </div>
      </div>
      
      <div class="card-actions justify-end mt-4">
        <button 
          class="btn btn-primary" 
          on:click={updateAccountInfo} 
          disabled={savingInfo}
        >
          {savingInfo ? $_('profile.saving') : $_('profile.saveChanges')}
        </button>
      </div>
    </div>
  </div>
  
  <!-- Change Password (hidden for GmGard OAuth users) -->
  {#if !isGmGardUser}
    <div class="card bg-base-200 shadow-xl">
      <div class="card-body">
        <h2 class="card-title text-2xl mb-4">{$_('profile.changePassword')}</h2>
        
        <form on:submit|preventDefault={changePassword}>
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
