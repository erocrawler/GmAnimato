<script lang="ts">
  import type { PageData } from './$types';
  
  export let data: PageData;
  
  let settings = data.settings;
  let users = data.users;
  let queueStatus: any = null;
  let saving = false;
  let loadingQueue = false;
  let message = '';
  
  // Role editor modal state
  let showRoleModal = false;
  let editingUser: { id: string; username: string; roles: string[] } | null = null;
  let roleInput = '';
  
  async function saveSettings() {
    saving = true;
    message = '';
    try {
      const response = await fetch('/api/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      
      if (response.ok) {
        message = '✓ Settings saved successfully';
        setTimeout(() => message = '', 3000);
      } else {
        const error = await response.json();
        message = '✗ Error: ' + (error.error || 'Failed to save settings');
      }
    } catch (err) {
      message = '✗ Error: ' + String(err);
    } finally {
      saving = false;
    }
  }
  
  async function loadQueueStatus() {
    loadingQueue = true;
    try {
      const response = await fetch('/api/admin/queue-status');
      if (response.ok) {
        queueStatus = await response.json();
      }
    } catch (err) {
      console.error('Failed to load queue status:', err);
    } finally {
      loadingQueue = false;
    }
  }
  
  async function unpublishVideo(videoId: string, username: string) {
    if (!confirm(`Unpublish video from ${username}?`)) return;
    
    try {
      const response = await fetch(`/api/admin/videos/${videoId}/unpublish`, {
        method: 'POST',
      });
      
      if (response.ok) {
        message = '✓ Video unpublished';
        setTimeout(() => message = '', 3000);
        // Reload page to refresh data
        window.location.reload();
      } else {
        const error = await response.json();
        message = '✗ Error: ' + (error.error || 'Failed to unpublish video');
      }
    } catch (err) {
      message = '✗ Error: ' + String(err);
    }
  }
  
  async function updateUserRole(userId: string, username: string, currentRoles: string[]) {
    const roles = currentRoles || [];
    editingUser = { id: userId, username, roles };
    roleInput = roles.join(', ');
    showRoleModal = true;
  }
  
  async function saveUserRole() {
    if (!editingUser) return;
    
    const updatedRoles = roleInput.split(',').map(r => r.trim()).filter(r => r);
    
    try {
      const response = await fetch(`/api/admin/users/${editingUser.id}/roles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roles: updatedRoles }),
      });
      
      if (response.ok) {
        message = '✓ User role updated';
        setTimeout(() => message = '', 3000);
        // Update local data
        users = users.map(u => u.id === editingUser!.id ? { ...u, roles: updatedRoles } : u);
        closeRoleModal();
      } else {
        const error = await response.json();
        message = '✗ Error: ' + (error.error || 'Failed to update role');
      }
    } catch (err) {
      message = '✗ Error: ' + String(err);
    }
  }
  
  function closeRoleModal() {
    showRoleModal = false;
    editingUser = null;
    roleInput = '';
  }
  
  function toggleRole(role: string) {
    const roles = roleInput.split(',').map(r => r.trim()).filter(r => r);
    const index = roles.indexOf(role);
    
    if (index > -1) {
      roles.splice(index, 1);
    } else {
      roles.push(role);
    }
    
    roleInput = roles.join(', ');
  }
  
  function isRoleSelected(role: string) {
    const roles = roleInput.split(',').map(r => r.trim()).filter(r => r);
    return roles.includes(role);
  }
  
  // Load queue status on mount
  $: if (typeof window !== 'undefined') {
    loadQueueStatus();
  }
</script>

<div class="container mx-auto p-6 max-w-6xl">
  <h1 class="text-3xl font-bold mb-6">Admin Dashboard</h1>
  
  {#if message}
    <div class="alert mb-4" class:alert-success={message.startsWith('✓')} class:alert-error={message.startsWith('✗')}>
      {message}
    </div>
  {/if}
  
  <!-- System Settings -->
  <div class="card bg-base-200 shadow-xl mb-6">
    <div class="card-body">
      <h2 class="card-title text-2xl mb-4">System Settings</h2>
      
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="form-control">
          <label class="label cursor-pointer">
            <span class="label-text text-lg">Registration Enabled</span>
            <input type="checkbox" bind:checked={settings.registrationEnabled} class="toggle toggle-primary" />
          </label>
        </div>
        
        <div class="form-control">
          <label class="label">
            <span class="label-text">Free User Quota (per day)</span>
          </label>
          <input type="number" bind:value={settings.freeUserQuotaPerDay} class="input input-bordered" min="0" />
        </div>
        
        <div class="form-control">
          <label class="label">
            <span class="label-text">Paid User Quota (per day)</span>
          </label>
          <input type="number" bind:value={settings.paidUserQuotaPerDay} class="input input-bordered" min="0" />
        </div>
        
        <div class="form-control">
          <label class="label">
            <span class="label-text">Max Concurrent Jobs</span>
          </label>
          <input type="number" bind:value={settings.maxConcurrentJobs} class="input input-bordered" min="1" />
        </div>
        
        <div class="form-control">
          <label class="label">
            <span class="label-text">Max Queue Threshold</span>
          </label>
          <input type="number" bind:value={settings.maxQueueThreshold} class="input input-bordered" min="100" />
        </div>
      </div>
      
      <div class="card-actions justify-end mt-4">
        <button class="btn btn-primary" onclick={saveSettings} disabled={saving}>
          {saving ? 'Saving...' : 'Save Settings'}
        </button>
      </div>
    </div>
  </div>
  
  <!-- RunPod Queue Status -->
  <div class="card bg-base-200 shadow-xl mb-6">
    <div class="card-body">
      <h2 class="card-title text-2xl mb-4">RunPod Queue Status</h2>
      
      {#if loadingQueue}
        <div class="flex justify-center">
          <span class="loading loading-spinner loading-lg"></span>
        </div>
      {:else if queueStatus}
        <div class="mb-6">
          <h3 class="text-lg font-semibold mb-3">Job Statistics</h3>
          <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div class="stat bg-base-100 rounded-box">
              <div class="stat-title">In Queue</div>
              <div class="stat-value text-warning">{queueStatus.stats?.inQueue || 0}</div>
            </div>
            
            <div class="stat bg-base-100 rounded-box">
              <div class="stat-title">Processing</div>
              <div class="stat-value text-info">{queueStatus.stats?.inProgress || 0}</div>
            </div>
            
            <div class="stat bg-base-100 rounded-box">
              <div class="stat-title">Completed</div>
              <div class="stat-value text-success">{queueStatus.stats?.completed || 0}</div>
            </div>
            
            <div class="stat bg-base-100 rounded-box">
              <div class="stat-title">Failed</div>
              <div class="stat-value text-error">{queueStatus.stats?.failed || 0}</div>
            </div>
          </div>
        </div>

        {#if queueStatus.workers}
          <div class="mb-6">
            <h3 class="text-lg font-semibold mb-3">Worker Status</h3>
            <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Ready</div>
                <div class="stat-value text-success text-2xl">{queueStatus.workers.ready || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Idle</div>
                <div class="stat-value text-info text-2xl">{queueStatus.workers.idle || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Running</div>
                <div class="stat-value text-primary text-2xl">{queueStatus.workers.running || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Initializing</div>
                <div class="stat-value text-warning text-2xl">{queueStatus.workers.initializing || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Throttled</div>
                <div class="stat-value text-warning text-2xl">{queueStatus.workers.throttled || 0}</div>
              </div>
              
              <div class="stat bg-base-100 rounded-box">
                <div class="stat-title">Unhealthy</div>
                <div class="stat-value text-error text-2xl">{queueStatus.workers.unhealthy || 0}</div>
              </div>
            </div>
          </div>
        {/if}
        
        <div class="mt-4">
          <div class="alert" class:alert-success={queueStatus.available} class:alert-warning={!queueStatus.available}>
            <span>
              Status: {queueStatus.available ? '✓ Available' : '⚠ Unavailable'}
              {#if queueStatus.reason}
                <br /><small>{queueStatus.reason}</small>
              {/if}
            </span>
          </div>
        </div>
      {:else}
        <p class="text-base-content/70">RunPod status not available</p>
      {/if}
      
      <div class="card-actions justify-end mt-4">
        <button class="btn btn-outline" onclick={loadQueueStatus} disabled={loadingQueue}>
          Refresh Status
        </button>
      </div>
    </div>
  </div>
  
  <!-- User Management -->
  <div class="card bg-base-200 shadow-xl">
    <div class="card-body">
      <h2 class="card-title text-2xl mb-4">User Management</h2>
      
      <div class="overflow-x-auto">
        <table class="table table-zebra">
          <thead>
            <tr>
              <th>Username</th>
              <th>Email</th>
              <th>Roles</th>
              <th>Videos</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each users as user}
              <tr>
                <td class="font-semibold">{user.username}</td>
                <td>{user.email || '-'}</td>
                <td>
                  <div class="flex gap-1 flex-wrap">
                    {#each (user.roles || []) as role}
                      <span class="badge badge-sm" class:badge-primary={role === 'admin'} class:badge-success={role === 'paid-tier'}>
                        {role}
                      </span>
                    {/each}
                  </div>
                </td>
                <td>{user.videoCount}</td>
                <td class="text-sm">{new Date(user.created_at).toLocaleDateString()}</td>
                <td>
                  <button 
                    class="btn btn-xs btn-outline"
                    onclick={() => updateUserRole(user.id, user.username, user.roles)}
                  >
                    Edit Role
                  </button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      
      <div class="text-sm text-base-content/70 mt-4">
        Total Users: {users.length}
      </div>
    </div>
  </div>
</div>

<!-- Role Editor Modal -->
{#if showRoleModal && editingUser}
  <div class="modal modal-open">
    <div class="modal-box">
      <h3 class="font-bold text-lg mb-4">Edit Roles for {editingUser.username}</h3>
      
      <div class="mb-4">
        <p class="text-sm text-base-content/70 mb-2">Select roles:</p>
        <div class="flex flex-wrap gap-2 mb-4">
          <button 
            class="btn btn-sm"
            class:btn-primary={isRoleSelected('admin')}
            class:btn-outline={!isRoleSelected('admin')}
            onclick={() => toggleRole('admin')}
          >
            Admin
          </button>
          <button 
            class="btn btn-sm"
            class:btn-success={isRoleSelected('paid-tier')}
            class:btn-outline={!isRoleSelected('paid-tier')}
            onclick={() => toggleRole('paid-tier')}
          >
            Paid Tier
          </button>
          <button 
            class="btn btn-sm"
            class:btn-outline={!isRoleSelected('free-tier')}
            onclick={() => toggleRole('free-tier')}
          >
            Free Tier
          </button>
        </div>
      </div>
      
      <div class="form-control mb-4">
        <label class="label" for="role-input">
          <span class="label-text">Roles (comma-separated)</span>
        </label>
        <input 
          id="role-input"
          type="text" 
          bind:value={roleInput}
          placeholder="admin, paid-tier, free-tier"
          class="input input-bordered w-full"
        />
        <label class="label">
          <span class="label-text-alt text-base-content/60">
            Available: admin, paid-tier, free-tier
          </span>
        </label>
      </div>
      
      <div class="modal-action">
        <button class="btn btn-ghost" onclick={closeRoleModal}>Cancel</button>
        <button class="btn btn-primary" onclick={saveUserRole}>Save</button>
      </div>
    </div>
    <div class="modal-backdrop" onclick={closeRoleModal}></div>
  </div>
{/if}

<style>
  .stat {
    padding: 1rem;
  }
</style>
