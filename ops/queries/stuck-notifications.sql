select id, notification_status, updated_at, notification_claimed_at, notified_at
from public.customer_leads
where notification_status = 'failed'
   or (notification_status = 'pending'
       and updated_at < now() - interval '10 minutes')
   or (notification_status = 'sending'
       and notification_claimed_at < now() - interval '10 minutes')
order by updated_at;
