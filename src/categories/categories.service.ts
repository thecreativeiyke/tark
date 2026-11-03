import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from './entities/category.entity';

const SEED_CATEGORIES = [
  { name: 'Plumbing & Pipefitting', slug: 'plumbing', icon: 'wrench' },
  { name: 'Electrical & Wiring', slug: 'electrical', icon: 'zap' },
  { name: 'Solar & Inverter Systems', slug: 'solar-inverter', icon: 'sun' },
  { name: 'Generator Mechanics', slug: 'generator-mechanic', icon: 'cpu' },
  { name: 'AC & Refrigeration', slug: 'ac-refrigeration', icon: 'thermometer' },
  { name: 'Carpentry & Woodwork', slug: 'carpentry', icon: 'tool' },
  { name: 'Painting & POP Ceiling', slug: 'painting-pop', icon: 'brush' },
  { name: 'Tiling & Masonry', slug: 'tiling-masonry', icon: 'grid' },
  { name: 'Aluminum & Welding', slug: 'welding-fabrication', icon: 'shield' },
];

@Injectable()
export class CategoriesService implements OnModuleInit {
  private readonly logger = new Logger(CategoriesService.name);

  constructor(
    @InjectRepository(Category)
    private categoryRepository: Repository<Category>,
  ) {}

  async onModuleInit() {
    const count = await this.categoryRepository.count();
    if (count === 0) {
      this.logger.log('Seeding default artisan categories into database...');
      await this.categoryRepository.save(SEED_CATEGORIES);
      this.logger.log('Categories seeded successfully.');
    }
  }

  findAllActive() {
    return this.categoryRepository.find({
      where: { isActive: true },
      order: { name: 'ASC' },
    });
  }

  findBySlug(slug: string) {
    return this.categoryRepository.findOneBy({ slug, isActive: true });
  }

  async resolveCategory(input: string): Promise<Category | null> {
    if (!input) return null;
    const trimmed = input.trim();
    // 1. Try exact slug match
    const bySlug = await this.categoryRepository.findOneBy({
      slug: trimmed.toLowerCase(),
      isActive: true,
    });
    if (bySlug) return bySlug;

    // 2. Try case-insensitive name match
    return this.categoryRepository
      .createQueryBuilder('category')
      .where('LOWER(category.name) = LOWER(:name)', { name: trimmed })
      .andWhere('category.isActive = true')
      .getOne();
  }
}
