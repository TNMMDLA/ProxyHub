# Node Pools

Node Pools group enabled nodes for policy routing. Create or edit a pool to batch-add and remove
members. Membership changes are saved atomically.

Delete impact shows policies that use the pool. A referenced pool cannot be deleted because doing
so would remove a policy outlet. ProxyHub does not provide force cascade deletion.
