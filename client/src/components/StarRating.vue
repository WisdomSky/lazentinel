<script setup lang="ts">
import { computed } from 'vue';
import { Star, StarHalf } from 'lucide-vue-next';

interface StarRatingProps {
  rating: number | null;
}

const props = defineProps<StarRatingProps>();

const normalizedRating = computed(() => {
  if (props.rating === null || !Number.isFinite(props.rating)) return null;
  return Math.min(5, Math.max(0, props.rating));
});

const ariaLabel = computed(() => {
  const rating = normalizedRating.value;
  return rating === null
    ? 'No ratings yet'
    : `Rated ${rating.toFixed(1)} out of 5 stars`;
});

const stars = computed(() => {
  const rating = normalizedRating.value ?? 0;
  return Array.from({ length: 5 }, (_, index) => {
    const remaining = rating - index;
    if (remaining >= 0.75) return 'full' as const;
    if (remaining >= 0.25) return 'half' as const;
    return 'empty' as const;
  });
});
</script>

<template>
  <span class="star-rating" role="img" :aria-label="ariaLabel">
    <template v-for="(star, index) in stars" :key="index">
      <StarHalf v-if="star === 'half'" aria-hidden="true" />
      <Star v-else aria-hidden="true" :class="{ 'is-empty': star === 'empty' }" />
    </template>
  </span>
</template>
